/**
 * A managed import of a new segmented page over 4 MiB replies at commit, before its projection is built (#7106).
 *
 * 1. Protects: a managed import (by reference, over the single-string ceiling, or by content, between 4 MiB and the
 *    ceiling) whose publication leaves the projection to be built after commit replies `imported` with
 *    `searchable: 'pending'`, `projection: 'pending'`, its `request_id` and the poll interval, while that build is
 *    still held; another import on the same source commits meanwhile; the receipt read (`get_write_request`) says
 *    `pending` until the page seals and `searchable: true` after. One build chunks the page. A new page up to 4 MiB
 *    is still sealed when its import replies, with no post-commit build.
 * 2. Fails when: the owner settles such an import only after its projection (the reply then waits for chunking and
 *    the per-row `to_tsvector` of the whole page, which on a loaded host outlasted the 30 s import wait and replied
 *    `write_pending`), the source's next write queues behind the build, the reply claims searchable before the seal,
 *    or the receipt never turns searchable.
 * 3. Existing coverage: managed-streamed-import.test.ts and managed-sync-streamed.test.ts assert the page seals; only
 *    a loaded host made the projection outlast the reply wait.
 * 4. Seam: the existing `segmented:projection_batch` fault point (fault-points.ts), held on a promise the test
 *    releases; `segmentChunkWork` counts the chunks built. Stopping the persistence consumer waits for the build it
 *    tracks, so the seal check after it is deterministic.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { SEGMENTED_CREATE_SEAL_MAX_BYTES } from '../../src/core/page-body/limits.ts';
import { segmentChunkWork } from '../../src/core/page-body/ingest.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../../src/core/persistence/identity.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { DETACHED_PROJECTION_BUILDS } from '../../src/core/persistence/consumer.ts';
import { DEFAULT_FLIP_RETIRE_MAX_ROWS } from '../../src/core/page-body/limits.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { conversationPage } from '../helpers/conversation-page.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-projection-pending-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const streamed = conversationPage(PAGE_MAX_BYTES + 1024 * 1024, { seed: 81 });
const midsize = conversationPage(SEGMENTED_CREATE_SEAL_MAX_BYTES + 512 * 1024, { seed: 82 });
const small = conversationPage(2 * 1024 * 1024, { seed: 83 });

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

for (const kind of testBackends()) {
  describe(`a managed import of a new page over 4 MiB replies at commit (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
    }, 120_000);
    afterEach(() => installFaultHook(undefined));
    afterAll(async () => {
      await withEnv(env, async () => { await disposePersistenceConsumer(engine); await close(); });
    });

    async function managedSource(): Promise<{ sourceId: string; root: string }> {
      await disposePersistenceConsumer(engine);
      await engine.setConfig('pages.segmented_storage', 'on');
      const sourceId = `pending-${randomUUID().slice(0, 8)}`;
      const root = join(home, sourceId);
      mkdirSync(join(root, 'notes'), { recursive: true });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await registerLocalWriter(engine, 'cli');
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      return { sourceId, root };
    }

    const importFile = async (f: { sourceId: string; root: string }, slug: string, body: string): Promise<Record<string, unknown>> => {
      writeFileSync(join(f.root, `${slug}.md`), body);
      return importManagedFile(engine, join(f.root, `${slug}.md`), `${slug}.md`, { sourceId: f.sourceId, noEmbed: true })
        .then(result => ({ ...result }), error => ({ status: 'error', code: (error as { code?: string }).code }));
    };
    const pageRow = async (sourceId: string, slug: string) => (await engine.executeRaw<{ body_storage: string; sealed: boolean; chunks: number }>(
      `SELECT body_storage, COALESCE(text_projection_revision = knowledge_revision, false) AS sealed,
        (SELECT count(*)::int FROM content_chunks c WHERE c.page_id = p.id) AS chunks FROM pages p WHERE source_id=$1 AND slug=$2`, [sourceId, slug]))[0] ?? null;
    const receipt = async (requestId: string) => {
      const registration = await registerLocalWriter(engine, 'cli');
      const response = await withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, 'get_write_request', { request_id: requestId },
        { remote: false, config: { engine: engine.kind }, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } } as never));
      return JSON.parse((response.content[0] as { text: string }).text) as Record<string, unknown>;
    };

    for (const [label, body] of [['by reference, over the single-string ceiling', streamed], ['by content, over 4 MiB', midsize]] as const) {
      test(`${label}: replies pending while its projection is held; the source's next import commits; the receipt turns searchable at the seal`, () => withEnv(env, async () => {
        const f = await managedSource();
        const slug = 'notes/pending';
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        let reached!: () => void;
        const entered = new Promise<void>(resolve => { reached = resolve; });
        installFaultHook(async (point, detail) => {
          if (point !== 'segmented:projection_batch' || detail.sourceId !== f.sourceId || detail.slug !== slug) return;
          reached();
          await held;
        });
        try {
          segmentChunkWork.chunks = 0;
          const reply = await importFile(f, slug, body);
          expect(reply).toMatchObject({ slug, status: 'imported', searchable: 'pending', projection: 'pending' });
          expect(typeof reply.request_id).toBe('string');
          expect(reply.searchable_retry_after_ms).toBeGreaterThanOrEqual(1000);
          // The reply came first; the build it left runs on to its first batch, where the hook holds it.
          await entered;
          expect(await pageRow(f.sourceId, slug)).toEqual({ body_storage: 'segmented', sealed: false, chunks: 0 });
          expect(await receipt(String(reply.request_id))).toMatchObject({ state: 'committed', searchable: 'pending' });

          expect(await importFile(f, 'notes/beside', '---\ntitle: Beside\n---\nA small note written while the projection is held.\n'))
            .toMatchObject({ slug: 'notes/beside', status: 'imported' });

          release();
          await disposePersistenceConsumer(engine);
          const sealed = await pageRow(f.sourceId, slug);
          expect(sealed).toMatchObject({ body_storage: 'segmented', sealed: true });
          expect(segmentChunkWork.chunks).toBe(sealed!.chunks);
          const settled = await receipt(String(reply.request_id));
          expect(settled).toMatchObject({ state: 'committed', searchable: true });
          expect(settled.projection).toBeUndefined();
        } finally {
          release();
          installFaultHook(undefined);
          await disposePersistenceConsumer(engine);
        }
      }), 300_000);
    }

    test('a new page up to 4 MiB is sealed when its import replies, with no post-commit build', () => withEnv(env, async () => {
      const f = await managedSource();
      let reached = false;
      installFaultHook(point => { if (point === 'segmented:projection_batch') reached = true; });
      expect(Buffer.byteLength(small)).toBeLessThanOrEqual(SEGMENTED_CREATE_SEAL_MAX_BYTES);
      const reply = await importFile(f, 'notes/small', small);
      expect(reply).toMatchObject({ slug: 'notes/small', status: 'imported', searchable: true });
      expect(reply.projection).toBeUndefined();
      expect(await pageRow(f.sourceId, 'notes/small')).toMatchObject({ body_storage: 'segmented', sealed: true });
      expect(reached).toBe(false);
      await disposePersistenceConsumer(engine);
    }), 120_000);

    test('detached builds run at most DETACHED_PROJECTION_BUILDS at a time (beside the resident drain\'s one page); every page seals and stop() drains them', () => withEnv(env, async () => {
      const f = await managedSource();
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const building = new Set<string>();
      let peak = 0;
      installFaultHook(async (point, detail) => {
        if (detail.sourceId !== f.sourceId || typeof detail.slug !== 'string') return;
        if (point === 'segmented:projection_staged') { building.delete(detail.slug); return; }
        if (point !== 'segmented:projection_batch' || building.has(detail.slug)) return;
        building.add(detail.slug);
        peak = Math.max(peak, building.size);
        await held;
      });
      const slugs = Array.from({ length: 6 }, (_, i) => `notes/many-${i}`);
      try {
        for (const [i, slug] of slugs.entries()) {
          expect(await importFile(f, slug, conversationPage(SEGMENTED_CREATE_SEAL_MAX_BYTES + 256 * 1024, { seed: 90 + i })))
            .toMatchObject({ slug, status: 'imported', searchable: 'pending' });
        }
        expect(peak).toBeLessThanOrEqual(DETACHED_PROJECTION_BUILDS + 1);
        release();
        await disposePersistenceConsumer(engine);
        expect(building.size).toBe(0);
        for (const slug of slugs) expect([slug, await pageRow(f.sourceId, slug)]).toMatchObject([slug, { body_storage: 'segmented', sealed: true }]);
        expect(peak).toBeLessThanOrEqual(DETACHED_PROJECTION_BUILDS + 1);
      } finally {
        release();
        installFaultHook(undefined);
        await disposePersistenceConsumer(engine);
      }
    }), 300_000);

    test('an edit whose retirement is deferred (pages.flip_retire_max_rows 1) still replies sealed: only a new page detaches its build', () => withEnv(env, async () => {
      const f = await managedSource();
      const slug = 'notes/edited';
      await engine.setConfig('pages.flip_retire_max_rows', '1');
      try {
        expect(await importFile(f, slug, conversationPage(2 * 1024 * 1024, { seed: 84 }))).toMatchObject({ slug, status: 'imported', searchable: true });
        const reply = await importFile(f, slug, conversationPage(2 * 1024 * 1024, { seed: 85 }));
        expect(reply).toMatchObject({ slug, status: 'imported', searchable: true });
        expect(reply.projection).toBeUndefined();
        expect(await pageRow(f.sourceId, slug)).toMatchObject({ body_storage: 'segmented', sealed: true });
        const [edit] = await engine.executeRaw<{ outcome: Record<string, unknown> }>(
          'SELECT outcome FROM persistence_requests WHERE source_id=$1 AND slug=$2 ORDER BY sequence DESC LIMIT 1', [f.sourceId, slug]);
        expect(edit!.outcome).toMatchObject({ projection: 'pending' });
      } finally {
        await engine.setConfig('pages.flip_retire_max_rows', String(DEFAULT_FLIP_RETIRE_MAX_ROWS));
        await disposePersistenceConsumer(engine);
      }
    }), 120_000);

    test('a quarantined new page over 4 MiB replies at commit (searchable false) while its projection is held', () => withEnv(env, async () => {
      const f = await managedSource();
      const slug = 'notes/quarantined';
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let reached!: () => void;
      const entered = new Promise<void>(resolve => { reached = resolve; });
      installFaultHook(async (point, detail) => {
        if (point !== 'segmented:projection_staged' || detail.sourceId !== f.sourceId || detail.slug !== slug) return;
        reached();
        await held;
      });
      try {
        const body = midsize.replace('title: Conversation log\n', 'title: Conversation log\nquarantine:\n  reason: test\n  detail: held for review\n');
        expect(body).not.toBe(midsize);
        const reply = await importFile(f, slug, body);
        expect(reply).toMatchObject({ slug, status: 'imported', searchable: false });
        await entered;
        expect(await pageRow(f.sourceId, slug)).toEqual({ body_storage: 'segmented', sealed: false, chunks: 0 });
        release();
        await disposePersistenceConsumer(engine);
        expect(await pageRow(f.sourceId, slug)).toEqual({ body_storage: 'segmented', sealed: true, chunks: 0 });
      } finally {
        release();
        installFaultHook(undefined);
        await disposePersistenceConsumer(engine);
      }
    }), 300_000);
  });
}
