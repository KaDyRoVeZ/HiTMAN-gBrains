/**
 * #7117: the content-drift sweep runs as bounded, resumable batches.
 *
 * Protects: invalidateContentDriftBatch examines at most `limit` chunk rows
 * past its cursor (before any hash is computed) and keeps the #4246 rules
 * (NULL hash grandfathered; embed_skip, archived-source and deleted pages
 * untouched); runContentDriftSweep saves its cursor with each batch, resumes
 * a stopped pass, waits out the pass interval after a completed multi-batch
 * pass, records a failed batch without moving the cursor, and lets a lost
 * lease propagate.
 * Regression it catches: the single unbatched UPDATE that a statement_timeout
 * cancelled on every run with nothing kept and the error swallowed.
 * Seam: none (PGLite; the Postgres timeout path is test/e2e/content-drift-sweep-postgres.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { invalidateContentDriftBatch } from '../src/core/engine-sql/chunks.ts';
import {
  CONTENT_DRIFT_PASS_INTERVAL_KEY,
  contentDriftSweepKey,
  parseContentDriftSweepState,
  readContentDriftSweepStates,
  runContentDriftSweep,
} from '../src/core/content-drift-sweep.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** A page with one embedded chunk; `drift` rewrites its text under the kept vector and hash. */
async function seed(slug: string, opts: { drift?: boolean; sourceId?: string } = {}): Promise<void> {
  const sourceId = opts.sourceId ?? 'default';
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'seeded' }, { sourceId });
  await installFixtureChunks(engine, slug, [{
    chunk_index: 0, chunk_text: `old text of ${slug}`, chunk_source: 'compiled_truth',
    token_count: 4, embedding: new Float32Array(1536).fill(0.2),
  }], { sourceId });
  if (opts.drift !== false) {
    await engine.executeRaw(
      `UPDATE content_chunks SET chunk_text = 'rewritten ' || chunk_text
        WHERE page_id = (SELECT id FROM pages WHERE slug = $1 AND source_id = $2)`, [slug, sourceId]);
  }
}

async function vectorKept(slug: string, sourceId = 'default'): Promise<boolean> {
  const [row] = await engine.executeRaw<{ kept: boolean }>(
    `SELECT cc.embedding IS NOT NULL AS kept FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = $1 AND p.source_id = $2`, [slug, sourceId]);
  return row!.kept;
}

async function column(): Promise<string> {
  const { resolveActiveEmbeddingColumnFromEngine } = await import('../src/core/search/embedding-column.ts');
  return (await resolveActiveEmbeddingColumnFromEngine(engine)).name;
}

/** The sweep's `stopped` hook, true from its (n+1)th check on: exactly n batches run. */
function afterBatches(n: number): () => boolean {
  let checks = 0;
  return () => checks++ >= n;
}

describe('invalidateContentDriftBatch', () => {
  test('examines at most limit rows past the cursor and keeps the eligibility rules', async () => {
    for (const slug of ['d1', 'd2', 'd3', 'd4']) await seed(slug);
    await seed('current', { drift: false });
    await seed('legacy');
    await engine.executeRaw(`UPDATE content_chunks SET embedded_text_hash = NULL
      WHERE page_id = (SELECT id FROM pages WHERE slug = 'legacy')`);
    await seed('skipped');
    await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"embed_skip": true}'::jsonb WHERE slug = 'skipped'`);
    await seed('deleted');
    await engine.softDeletePage('deleted', { sourceId: 'default' });
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('shelf', 'shelf', '{"federated":true}'::jsonb)`);
    await seed('archived', { sourceId: 'shelf' });
    await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'shelf'`);

    const col = await column();
    const run = <T>(fn: (tx: PGLiteEngine) => Promise<T>) => engine.transaction(fn as never) as Promise<T>;
    const batches = [];
    let after = 0;
    for (;;) {
      const batch = await invalidateContentDriftBatch(run, col, { afterChunkId: after, limit: 3 });
      batches.push(batch);
      if (batch.lastChunkId === null) break;
      expect(batch.lastChunkId).toBeGreaterThan(after);
      after = batch.lastChunkId;
    }
    expect(batches.map(b => b.checked)).toEqual([3, 3, 3, 0]);
    expect(batches.reduce((n, b) => n + b.drifted, 0)).toBe(4);
    for (const slug of ['d1', 'd2', 'd3', 'd4']) expect(await vectorKept(slug)).toBe(false);
    for (const slug of ['current', 'legacy', 'skipped', 'deleted']) expect(await vectorKept(slug)).toBe(true);
    expect(await vectorKept('archived', 'shelf')).toBe(true);
  });
});

describe('runContentDriftSweep', () => {
  test('a stopped pass keeps its cursor and the next run finishes it', async () => {
    for (let i = 0; i < 7; i++) await seed(`p${i}`);
    const first = await runContentDriftSweep(engine, { batchRows: 2, stopped: afterBatches(2) });
    expect(first).toMatchObject({ state: 'stopped', batches: 2, checked: 4, drifted: 4 });
    const saved = parseContentDriftSweepState(await engine.getConfig(contentDriftSweepKey(await column())));
    expect(saved.cursor).toBe(first.cursor);
    expect(saved.cursor).toBeGreaterThan(0);
    expect(saved).toMatchObject({ pass_checked: 4, pass_drifted: 4, last_completed_at: null });

    const second = await runContentDriftSweep(engine, { batchRows: 2 });
    expect(second).toMatchObject({ state: 'complete', checked: 3, drifted: 3, cursor: 0 });
    for (let i = 0; i < 7; i++) expect(await vectorKept(`p${i}`)).toBe(false);
    const [{ state }] = await readContentDriftSweepStates(engine);
    expect(state).toMatchObject({ cursor: 0, last_pass_checked: 7, last_pass_drifted: 4 + 3, last_error: null });
    expect(state.last_completed_at).not.toBeNull();
  });

  test('a completed multi-batch pass waits out the interval; 0 hours repeats it', async () => {
    for (let i = 0; i < 3; i++) await seed(`w${i}`);
    expect((await runContentDriftSweep(engine, { batchRows: 2 })).state).toBe('complete');
    await seed('late');
    const idle = await runContentDriftSweep(engine, { batchRows: 2 });
    expect(idle).toMatchObject({ state: 'waiting', batches: 0 });
    expect(Date.parse(idle.next_pass_at!)).toBeGreaterThan(Date.now() + 23 * 3_600_000);
    expect(await vectorKept('late')).toBe(true);

    await engine.setConfig(CONTENT_DRIFT_PASS_INTERVAL_KEY, '0');
    expect(await runContentDriftSweep(engine, { batchRows: 2 })).toMatchObject({ state: 'complete', drifted: 1 });
    expect(await vectorKept('late')).toBe(false);
  });

  test('a pass that fits in one batch runs on every call', async () => {
    await seed('a');
    expect((await runContentDriftSweep(engine)).state).toBe('complete');
    await seed('b');
    expect(await runContentDriftSweep(engine)).toMatchObject({ state: 'complete', drifted: 1 });
  });

  test('source scopes keep separate cursors and touch only their source', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('other', 'other', '{"federated":true}'::jsonb)`);
    await seed('mine');
    await seed('theirs', { sourceId: 'other' });
    expect(await runContentDriftSweep(engine, { sourceId: 'default' })).toMatchObject({ scope: 'source:default', drifted: 1 });
    expect(await vectorKept('theirs', 'other')).toBe(true);
    expect((await readContentDriftSweepStates(engine)).map(s => s.key)).toEqual([contentDriftSweepKey(await column(), 'default')]);
  });

  test('a failed batch is reported and recorded, and the cursor stays before it', async () => {
    for (let i = 0; i < 4; i++) await seed(`f${i}`);
    await runContentDriftSweep(engine, { batchRows: 2, stopped: afterBatches(1) });
    const before = parseContentDriftSweepState(await engine.getConfig(contentDriftSweepKey(await column())));
    await engine.executeRaw(`CREATE FUNCTION refuse_chunk_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'chunk writes refused for this test'; END $$`);
    await engine.executeRaw(`CREATE TRIGGER refuse_chunk_update BEFORE UPDATE ON content_chunks FOR EACH ROW EXECUTE FUNCTION refuse_chunk_update()`);
    try {
      const failed = await runContentDriftSweep(engine, { batchRows: 2 });
      expect(failed.state).toBe('failed');
      expect(failed.error).toContain('chunk writes refused for this test');
      expect(failed.cursor).toBe(before.cursor);
      const after = parseContentDriftSweepState(await engine.getConfig(contentDriftSweepKey(await column())));
      expect(after.cursor).toBe(before.cursor);
      expect(after.last_error?.message).toContain('chunk writes refused for this test');
    } finally {
      await engine.executeRaw('DROP TRIGGER refuse_chunk_update ON content_chunks');
      await engine.executeRaw('DROP FUNCTION refuse_chunk_update()');
    }
    const resumed = await runContentDriftSweep(engine, { batchRows: 2 });
    expect(resumed).toMatchObject({ state: 'complete', drifted: 2 });
    expect(parseContentDriftSweepState(await engine.getConfig(contentDriftSweepKey(await column()))).last_error).toBeNull();
  });

  test('a lost lease propagates and leaves the batch uncommitted', async () => {
    await seed('owned');
    const lost = new Error('lease lost');
    await expect(runContentDriftSweep(engine, { assertOwned: async () => { throw lost; } })).rejects.toBe(lost);
    expect(await vectorKept('owned')).toBe(true);
  });

  test('embedStaleForSource reports the sweep and re-embeds what it invalidated', async () => {
    await seed('drifted');
    const result = await embedStaleForSource(engine, 'default', {
      embedFn: async texts => texts.map(() => new Float32Array(1536).fill(0.1)),
    });
    expect(result.contentDrift).toMatchObject({ scope: 'source:default', state: 'complete', drifted: 1 });
    expect(result.invalidated).toBe(1);
    expect(result.embedded).toBe(1);
  });
});
