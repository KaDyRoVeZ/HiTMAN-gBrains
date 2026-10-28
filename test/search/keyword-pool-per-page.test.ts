/**
 * GBRA-156: the keyword arm's chunk pool (the inner LIMIT before the
 * best-chunk-per-page collapse) keeps one chunk per page, so a page with
 * hundreds of matching chunks cannot push every other matching page out of
 * the arm. Before, a page with 300 matching chunks filled a limit-10 pool and
 * the only other matching page was lost. PGLite here; the Postgres arm runs
 * in test/e2e/keyword-or-narrow-postgres.test.ts.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { seedPage } from '../helpers/keyword-paging-fixture.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedPage(engine, 'notes/quasar-log', 'The quasar log. Each entry below cites the quasar survey.');
  await engine.executeRaw(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, modality)
     SELECT cc.page_id, cc.chunk_index + g, cc.chunk_text || ' entry ' || g, cc.chunk_source, cc.modality
     FROM content_chunks cc JOIN pages p ON p.id = cc.page_id, generate_series(1, 299) g
     WHERE p.slug = 'notes/quasar-log' AND cc.chunk_index = 0`);
  await seedPage(engine, 'notes/nebulith-field', 'Field notes on the nebulith deposit.');
}, 120_000);

afterAll(async () => { await engine.disconnect(); });

test('a page with hundreds of matching chunks does not crowd the only other match out of the pool', async () => {
  const relaxed = await engine.searchKeyword('quasar nebulith zzqxv', { limit: 10, orFallback: true });
  expect(relaxed.map(r => r.slug).sort()).toEqual(['notes/nebulith-field', 'notes/quasar-log']);
  const strict = await engine.searchKeyword('quasar OR nebulith', { limit: 10 });
  expect(strict.map(r => r.slug).sort()).toEqual(['notes/nebulith-field', 'notes/quasar-log']);
});
