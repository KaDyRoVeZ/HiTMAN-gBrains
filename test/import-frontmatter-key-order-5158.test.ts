/**
 * #5158: reordering frontmatter keys is not a content change.
 *
 * Protects: re-importing a page whose file differs from the stored row only in
 * frontmatter key order (top-level or nested) writes nothing: status skipped,
 * same chunks, same stored content_hash, no version snapshot. A real value,
 * tag or body change still imports.
 * Fails when: the importer trusts only the insertion-order content_hash, so a
 * key reorder re-chunks (and on an embedding brain, re-embeds) the page.
 * Seams: none; PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const A = '---\ntitle: Synthetic note\ntype: note\ntags: [alpha, beta]\nalpha: one\nbeta: two\nnested:\n  x: 1\n  y: 2\n---\n\nIdentical synthetic body.\n';
const REORDERED = '---\nnested:\n  y: 2\n  x: 1\nbeta: two\ntags: [beta, alpha]\ntype: note\nalpha: one\ntitle: Synthetic note\n---\n\nIdentical synthetic body.\n';

for (const backend of testBackends()) describe(`#5158 frontmatter key order (${backend})`, () => {
  let engine: BrainEngine, close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
  }, 120_000);
  afterAll(async () => { if (close) await close(); else await engine.disconnect(); });

  const state = async (slug: string) => {
    const page = (await engine.getPage(slug))!;
    const [{ n: versions }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_versions WHERE page_id=$1', [page.id]);
    const chunks = await engine.executeRaw<{ id: number }>('SELECT id FROM content_chunks WHERE page_id=$1 ORDER BY id', [page.id]);
    return { hash: page.content_hash, updated: String(page.updated_at), versions, chunks: chunks.map(c => Number(c.id)) };
  };

  test('a key-order-only re-import writes nothing and keeps the stored hash', async () => {
    expect((await importFromContent(engine, 'notes/key-order', A, { noEmbed: true })).status).toBe('imported');
    const before = await state('notes/key-order');
    for (let i = 0; i < 2; i++) {
      const result = await importFromContent(engine, 'notes/key-order', REORDERED, { noEmbed: true });
      expect(result).toMatchObject({ status: 'skipped', chunks: 0 });
      expect(await state('notes/key-order')).toEqual(before);
    }
  });

  test('a changed value, tag or body still imports', async () => {
    await importFromContent(engine, 'notes/key-order-change', A, { noEmbed: true });
    for (const changed of [
      REORDERED.replace('alpha: one', 'alpha: three'),
      REORDERED.replace('  x: 1', '  x: 9'),
      REORDERED.replace('tags: [beta, alpha]', 'tags: [beta, alpha, gamma]'),
      REORDERED.replace('Identical synthetic body.', 'A different synthetic body.'),
    ]) {
      const before = await state('notes/key-order-change');
      expect((await importFromContent(engine, 'notes/key-order-change', changed, { noEmbed: true })).status).toBe('imported');
      expect((await state('notes/key-order-change')).hash).not.toBe(before.hash);
    }
  });
});
