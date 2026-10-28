import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { invalidateStaleSignatureEmbeddingsGuarded } from '../../src/core/embedding-invalidation.ts';
let engine: PostgresEngine;
const d = hasDatabase() ? describe : describe.skip;
async function seedUnembedded(slug: string, text: string) {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
  await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', token_count: 4 }]);
}
d('embedding migration excludes soft-deleted pages', () => {
  beforeAll(async () => { engine = await setupDB(); }, 60000);
  afterAll(async () => { await teardownDB(); });
  beforeEach(async () => { await engine.executeRaw('TRUNCATE pages CASCADE'); });
  test.each(['guarded', 'raw'] as const)('%s signature invalidation preserves tombstone vectors and invalidates live vectors', async (mode) => {
    const deleted = `deleted-drift-${mode}`;
    const live = `live-drift-${mode}`;
    const [{ dim }] = await engine.executeRaw<{ dim: number }>(
      "SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0");
    for (const slug of [deleted, live]) {
      await seedUnembedded(slug, 'stale vector');
      await engine.executeRaw(
        `UPDATE content_chunks SET embedding = ('[' || array_to_string(array_fill(0.0::real, ARRAY[$1::int]), ',') || ']')::vector
         WHERE page_id = (SELECT id FROM pages WHERE slug = $2 AND source_id = 'default')`, [dim, slug]);
      await engine.setPageEmbeddingSignature(slug, { signature: 'old:model:1' });
    }
    await engine.softDeletePage(deleted, { sourceId: 'default' });
    const readVector = (slug: string) => engine.executeRaw<{ embedding: string | null }>(
      `SELECT cc.embedding::text AS embedding FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
       WHERE p.slug = $1 AND p.source_id = 'default'`, [slug]);
    const retained = await readVector(deleted);
    expect(retained[0]!.embedding).not.toBeNull();
    const opts = { signature: 'new:model:1' };
    const invalidated = mode === 'guarded'
      ? await invalidateStaleSignatureEmbeddingsGuarded(engine, opts)
      : await engine.invalidateStaleSignatureEmbeddings(opts);
    expect(invalidated).toBe(1);
    expect(await readVector(deleted)).toEqual(retained);
    expect(await readVector(live)).toEqual([{ embedding: null }]);
  });
  test('content drift invalidates only live chunks and preserves deleted chunk metadata', async () => {
    for (const slug of ['deleted-content-drift', 'live-content-drift']) {
      await seedUnembedded(slug, 'current text');
      const [{ dim }] = await engine.executeRaw<{ dim: number }>(
        "SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid='content_chunks'::regclass AND attname='embedding' AND attnum>0");
      await engine.executeRaw(`UPDATE content_chunks SET embedding=('[' || array_to_string(array_fill(0.0::real,ARRAY[$1::int]),',') || ']')::vector,
        embedded_text_hash=md5('old text'),embedded_at='2020-01-01T00:00:00Z'
        WHERE page_id=(SELECT id FROM pages WHERE slug=$2 AND source_id='default')`, [dim, slug]);
    }
    await engine.softDeletePage('deleted-content-drift', { sourceId: 'default' });
    const readDeleted = () => engine.executeRaw(`SELECT embedding::text,embedded_text_hash,embedded_at FROM content_chunks
      WHERE page_id=(SELECT id FROM pages WHERE slug='deleted-content-drift' AND source_id='default')`);
    const before = await readDeleted();
    expect(await engine.invalidateContentDriftEmbeddings()).toBe(1);
    expect(await readDeleted()).toEqual(before);
    expect(await engine.executeRaw(`SELECT embedding FROM content_chunks WHERE page_id=(SELECT id FROM pages
      WHERE slug='live-content-drift' AND source_id='default')`)).toEqual([{ embedding: null }]);
  });

  test('counts and both cursor orders ignore tombstones while preserving their recoverable chunks', async () => {
    await seedUnembedded('tombstone', 'deleted chunk');
    await engine.softDeletePage('tombstone', { sourceId: 'default' });
    await seedUnembedded('live', 'live');
    await seedUnembedded('later-tombstone', 'later deleted');
    await engine.softDeletePage('later-tombstone', { sourceId: 'default' });
    const updatedAt = '2020-01-02T03:04:05.000Z';
    await engine.executeRaw("UPDATE pages SET updated_at = $1::timestamptz WHERE slug = 'live' AND source_id = 'default'", [updatedAt]);
    for (const scope of [{}, { sourceId: 'default' }]) {
      expect(await engine.countStaleChunks(scope)).toBe(1);
      expect(await engine.countStaleChunks({ ...scope, signature: 'new:model:1024', includeNullSignature: true })).toBe(1);
      expect(await engine.sumStaleChunkChars(scope)).toBe(4);
      for (const orderBy of ['page_id', 'updated_desc'] as const) {
        const rows = await engine.listStaleChunks({ ...scope, orderBy, batchSize: 1 });
        expect(rows.map(row => row.slug)).toEqual(['live']);
        const last = rows[0]!;
        const rest = await engine.listStaleChunks({ ...scope, orderBy, batchSize: 1,
          afterPageId: last.page_id, afterChunkIndex: last.chunk_index,
          ...(orderBy === 'updated_desc' ? { afterUpdatedAt: updatedAt } : {}) });
        expect(rest).toHaveLength(0);
      }
    }
    expect((await engine.getPage('tombstone', { sourceId: 'default', includeDeleted: true }))?.deleted_at).not.toBeNull();
    expect(await engine.executeRaw("SELECT count(*)::int AS n FROM content_chunks WHERE page_id=(SELECT id FROM pages WHERE slug='tombstone')")).toEqual([{ n: 1 }]);
  });
});
