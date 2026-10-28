/**
 * A detached projection build holds its page's key lock for one bounded insert at a time, so a write to the page
 * publishes in one attempt (#7178 follow-up).
 *
 * 1. Protects: a managed import of a new page over 4 MiB replies at commit and builds its projection after; each
 *    insert transaction of that build stages at most PROJECTION_LOCK_HOLD_BYTES of segments under the page lock.
 *    A delete_page of the file-backed page (over the single-string ceiling) submitted while an insert holds the lock
 *    waits for that insert only, inside its publication's 1 s `lock_timeout`, and publishes on its first
 *    preparation: one preparation, no transient interruption, one copy of the prior file to its before stage. An
 *    uninterrupted build still chunks every occurrence and seals. The lock transaction also holds a key-share lock on
 *    the source row (its `page_write_guards` insert), which a source-exclusive publication (a managed sync import,
 *    `SELECT ... FROM sources ... FOR UPDATE`) waits for: a managed sync of a new page over the ceiling beside a small
 *    one imports both in one call, the small page published on its first preparation while the big page's build runs.
 * 2. Fails when: a build transaction inserts a whole STAGE_BATCH_BYTES batch (4 MiB) under the lock: about 0.7 s on
 *    an idle Postgres and past 1 s on a loaded host, where the waiting delete fails 55P03, prepares again and copies
 *    the 25 MiB file twice (CI run 39528224523: `bytesCopied` exactly twice the file); and every sync import on the
 *    source waits out each batch the same way, so a loaded host's first sync left the small page to its next pass
 *    (`filesImported: 1` on the call that settled, GitHub job 118987907022).
 * 3. Existing coverage: segmented-delete-restore-file.slow.test.ts deletes a page whose detached build may still run
 *    and failed on a loaded host with two copies; nothing drove the overlap on purpose or bounded the hold.
 * 4. Seam: the `segmented:projection_insert` fault point (fault-points.ts) inside each insert transaction, after its
 *    page lock; on Postgres the test holds the first insert there until the delete is prepared, so the delete's
 *    publication waits for that insert. `segmentChunkWork.heldBytes` (the largest insert) and `largeFileWork` are
 *    the modules' own work counters. PGLite has one connection, so its arm submits the write without holding.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set (test/postgres-unit-arms.txt).
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { PAGE_MAX_BYTES } from '../../src/core/page-size-policy.ts';
import { PROJECTION_LOCK_HOLD_BYTES } from '../../src/core/page-body/limits.ts';
import { segmentChunkWork } from '../../src/core/page-body/ingest.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { importManagedFile } from '../../src/core/persistence/import-mutations.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { largeFileWork } from '../../src/core/persistence/large-file.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { conversationPage } from '../helpers/conversation-page.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-projection-lock-hold-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const logger = { info() {}, warn() {}, error() {} };
const body = conversationPage(PAGE_MAX_BYTES + 1024 * 1024, { seed: 7178 });

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

/** A loaded host can outlast the reply wait: the same call (same request_id) is repeated until it settles. */
async function settled<T>(call: () => Promise<T>): Promise<T> {
  for (;;) {
    try { return await call(); }
    catch (error) { if ((error as { code?: string }).code !== 'write_pending') throw error; await Bun.sleep(1000); }
  }
}

for (const kind of testBackends()) {
  describe(`a detached projection build holds the page lock one bounded insert at a time (${kind})`, () => {
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

    async function managedSource(): Promise<{ sourceId: string; root: string; ctx: OperationContext }> {
      await disposePersistenceConsumer(engine);
      await engine.setConfig('pages.segmented_storage', 'on');
      const sourceId = `hold-${randomUUID().slice(0, 8)}`;
      const root = join(home, sourceId);
      mkdirSync(join(root, 'notes'), { recursive: true });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await registerLocalWriter(engine, 'cli');
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const ctx = { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger } as OperationContext;
      return { sourceId, root, ctx };
    }

    const importPage = async (f: { sourceId: string; root: string }, slug: string) => {
      writeFileSync(join(f.root, `${slug}.md`), body);
      return { ...await importManagedFile(engine, join(f.root, `${slug}.md`), `${slug}.md`, { sourceId: f.sourceId, noEmbed: true }) } as Record<string, unknown>;
    };
    const pageRow = async (sourceId: string, slug: string) => (await engine.executeRaw<{ deleted: boolean; sealed: boolean; chunks: number; unchunked: number }>(
      `SELECT deleted_at IS NOT NULL AS deleted, COALESCE(text_projection_revision = knowledge_revision, false) AS sealed,
        (SELECT count(*)::int FROM content_chunks c WHERE c.page_id = p.id) AS chunks,
        (SELECT count(*)::int FROM page_body_manifest m WHERE m.page_id = p.id AND m.staging_id IS NULL AND m.gen_to IS NULL
          AND NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id = p.id AND c.occurrence_id = m.occurrence_id)) AS unchunked
       FROM pages p WHERE source_id=$1 AND slug=$2`, [sourceId, slug]))[0] ?? null;

    test('a delete submitted while a build insert holds the page lock publishes on its first preparation, copying the file once', () => withEnv(env, async () => {
      const f = await managedSource();
      const slug = 'notes/held';
      let locked!: () => void;
      const inserting = new Promise<void>(resolve => { locked = resolve; });
      let release!: () => void;
      const prepared = new Promise<void>(resolve => { release = resolve; });
      let deleteRequest: string | undefined;
      let preparations = 0;
      installFaultHook(async (point, detail) => {
        if (detail.sourceId !== f.sourceId) return;
        if (point === 'consumer:preparing' && detail.operation === 'delete_page') { preparations++; deleteRequest = detail.requestId; return; }
        if (point === 'publication:prepared' && detail.operation === 'delete_page') { release(); return; }
        if (point !== 'segmented:projection_insert' || detail.slug !== slug) return;
        locked();
        // Postgres: hold this insert, under its page lock, until the delete's publication is about to take that lock.
        if (kind === 'postgres') await Promise.race([prepared, Bun.sleep(60_000)]);
      });
      try {
        segmentChunkWork.heldBytes = 0;
        expect(await importPage(f, slug)).toMatchObject({ slug, status: 'imported', searchable: 'pending', projection: 'pending' });
        await inserting;
        for (const key of Object.keys(largeFileWork) as Array<keyof typeof largeFileWork>) largeFileWork[key] = 0;
        const [{ revision }] = await engine.executeRaw<{ revision: string }>('SELECT knowledge_revision::text AS revision FROM pages WHERE source_id=$1 AND slug=$2', [f.sourceId, slug]);
        const params = { slug, expected_revision: revision, request_id: randomUUID() };
        const deleted = await settled(() => submitPageMutation(f.ctx, { operation: 'delete_page', params }));
        expect(deleted).toMatchObject({ status: 'soft_deleted', noop: false });
        expect(existsSync(join(f.root, `${slug}.md`))).toBe(false);
        expect(preparations).toBe(1);
        const [request] = await engine.executeRaw<{ state: string; transient_interruptions: number }>(
          'SELECT state, transient_interruptions FROM persistence_requests WHERE request_id=$1', [deleteRequest]);
        expect(request).toEqual({ state: 'committed', transient_interruptions: 0 });
        expect(largeFileWork.bytesCopied).toBe(Buffer.byteLength(body));
        expect(segmentChunkWork.heldBytes).toBeGreaterThan(0);
        expect(segmentChunkWork.heldBytes).toBeLessThanOrEqual(PROJECTION_LOCK_HOLD_BYTES);
      } finally {
        release();
        installFaultHook(undefined);
        await disposePersistenceConsumer(engine);
      }
    }), 600_000);

    test('an uninterrupted build chunks every occurrence in bounded inserts and seals', () => withEnv(env, async () => {
      const f = await managedSource();
      const slug = 'notes/sealed';
      let inserts = 0;
      installFaultHook((point, detail) => { if (point === 'segmented:projection_insert' && detail.sourceId === f.sourceId) inserts++; });
      segmentChunkWork.heldBytes = 0;
      segmentChunkWork.chunks = 0;
      expect(await importPage(f, slug)).toMatchObject({ slug, status: 'imported', searchable: 'pending' });
      await disposePersistenceConsumer(engine);
      const row = await pageRow(f.sourceId, slug);
      expect(row).toMatchObject({ deleted: false, sealed: true, unchunked: 0 });
      expect(row!.chunks).toBe(segmentChunkWork.chunks);
      expect(segmentChunkWork.heldBytes).toBeLessThanOrEqual(PROJECTION_LOCK_HOLD_BYTES);
      expect(inserts).toBeGreaterThanOrEqual(Math.ceil(Buffer.byteLength(body) / PROJECTION_LOCK_HOLD_BYTES));
    }), 600_000);
    test('a managed sync imports a small page beside a new page over the ceiling in one call while the big page\'s build holds its lock', () => withEnv(env, async () => {
      await disposePersistenceConsumer(engine);
      const sourceId = `hold-sync-${randomUUID().slice(0, 8)}`;
      const root = join(home, sourceId);
      mkdirSync(join(root, 'notes'), { recursive: true });
      const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
      git('init', '-q');
      writeFileSync(join(root, 'notes/huge.md'), body);
      writeFileSync(join(root, 'notes/small.md'), '---\ntitle: Small\n---\nA small note.\n');
      git('add', '-A');
      git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'test content');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}'::jsonb)", [sourceId, root]);
      await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      let release!: () => void;
      const prepared = new Promise<void>(resolve => { release = resolve; });
      let holding = false;
      const preparations = new Map<string, number>();
      const slugOf = async (writeId?: string) => (await engine.executeRaw<{ slug: string }>('SELECT slug FROM persistence_requests WHERE id=$1::uuid', [writeId]))[0]?.slug;
      installFaultHook(async (point, detail) => {
        if (detail.sourceId !== sourceId) return;
        if (point === 'consumer:preparing') { const slug = (await slugOf(detail.writeId)) ?? '?'; preparations.set(slug, (preparations.get(slug) ?? 0) + 1); return; }
        if (point === 'consumer:prepared' && await slugOf(detail.writeId) === 'notes/small') { release(); return; }
        if (point !== 'segmented:projection_insert' || detail.slug !== 'notes/huge' || holding) return;
        holding = true;
        // Postgres: hold this insert, under its page lock, until the small page's write is prepared and about to publish.
        if (kind === 'postgres') await Promise.race([prepared, Bun.sleep(60_000)]);
      });
      try {
        segmentChunkWork.heldBytes = 0;
        expect(await performManagedSync(engine, { sourceId, noPull: true, noEmbed: true })).toMatchObject({ status: 'first_sync', filesImported: 2 });
        expect(holding).toBe(true);
        expect(preparations.get('notes/small')).toBe(1);
        const [small] = await engine.executeRaw<{ state: string; transient_interruptions: number }>(
          "SELECT state, transient_interruptions FROM persistence_requests WHERE source_id=$1 AND slug='notes/small'", [sourceId]);
        expect(small).toEqual({ state: 'committed', transient_interruptions: 0 });
        await disposePersistenceConsumer(engine);
        expect(await pageRow(sourceId, 'notes/huge')).toMatchObject({ deleted: false, sealed: true, unchunked: 0 });
        expect(segmentChunkWork.heldBytes).toBeLessThanOrEqual(PROJECTION_LOCK_HOLD_BYTES);
      } finally {
        release();
        installFaultHook(undefined);
        await disposePersistenceConsumer(engine);
      }
    }), 600_000);
  });
}
