/**
 * #5088 on Postgres: the deferred ANN build uses CREATE INDEX CONCURRENTLY on
 * a reserved connection, so writers keep going while it waits and builds, and
 * an INVALID index left by an interrupted concurrent build is dropped and
 * rebuilt on resume.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getConn } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { annIndexValidity, buildDeferredAnnIndexes, canonicalChunkAnnIndex, type DeferredAnnIndex } from '../../src/core/embedding-ann-build.ts';

const RUN = hasDatabase();
const describeE2E = RUN ? describe : describe.skip;
let engine: PostgresEngine;
let dims: number;

async function build(pending: DeferredAnnIndex[]) {
  let list = pending;
  const result = await buildDeferredAnnIndexes(engine, { targetDims: dims, readPending: async () => list, writePending: async next => { list = next; }, log: () => {}, monitorIntervalMs: 200 });
  return { result, left: list };
}

describeE2E('deferred ANN build on Postgres (#5088)', () => {
  beforeAll(async () => {
    engine = await setupDB();
    const [{ dim }] = await engine.executeRaw<{ dim: number }>(
      "SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0 AND NOT attisdropped");
    dims = Number(dim);
    for (const slug of ['notes/ann-a', 'notes/ann-b']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: `text ${slug}`, chunk_source: 'compiled_truth', token_count: 2 }]);
    }
  }, 60_000);
  afterAll(async () => {
    if (engine && await annIndexValidity(engine, 'idx_chunks_embedding') !== true) await build([canonicalChunkAnnIndex()]);
    await teardownDB();
  });

  test('an INVALID index from an interrupted concurrent build is dropped and rebuilt', async () => {
    await getConn().unsafe("UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_chunks_embedding'::regclass");
    expect(await annIndexValidity(engine, 'idx_chunks_embedding')).toBe(false);
    const { result, left } = await build([canonicalChunkAnnIndex()]);
    expect(result.built).toEqual(['idx_chunks_embedding']);
    expect(left).toEqual([]);
    expect(await annIndexValidity(engine, 'idx_chunks_embedding')).toBe(true);
  }, 60_000);

  test('writers to content_chunks proceed while the build waits on an open writer transaction', async () => {
    await engine.executeRaw('DROP INDEX IF EXISTS idx_chunks_embedding');
    const holder = await getConn().reserve();
    try {
      await holder.unsafe('BEGIN');
      await holder.unsafe("UPDATE content_chunks SET token_count = token_count WHERE page_id = (SELECT id FROM pages WHERE slug = 'notes/ann-a')");
      const building = build([canonicalChunkAnnIndex()]);
      const deadline = Date.now() + 10_000;
      for (;;) {
        const waiting = await getConn().unsafe("SELECT 1 FROM pg_stat_activity WHERE query ILIKE 'CREATE INDEX CONCURRENTLY%idx_chunks_embedding%' AND state = 'active'");
        if (waiting.length) break;
        if (Date.now() > deadline) throw new Error('build never started');
        await Bun.sleep(50);
      }
      const write = engine.executeRaw("UPDATE content_chunks SET chunk_text = 'edited while indexing' WHERE page_id = (SELECT id FROM pages WHERE slug = 'notes/ann-b')");
      const outcome = await Promise.race([write.then(() => 'written'), Bun.sleep(5_000).then(() => 'blocked')]);
      expect(outcome).toBe('written');
      await holder.unsafe('COMMIT');
      const { result } = await building;
      expect(result.built).toEqual(['idx_chunks_embedding']);
      expect(await annIndexValidity(engine, 'idx_chunks_embedding')).toBe(true);
    } finally {
      await holder.unsafe('ROLLBACK').catch(() => {});
      holder.release();
    }
  }, 60_000);
});
