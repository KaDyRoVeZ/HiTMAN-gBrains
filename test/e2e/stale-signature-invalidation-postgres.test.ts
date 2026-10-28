/**
 * #7148: the stale-signature invalidation under a statement_timeout, on real Postgres.
 *
 * Protects: after a model or width swap nearly every chunk is out of the
 * target space, and the invalidation still finishes on a brain where one
 * statement over every chunk would outrun statement_timeout: each statement
 * covers one window of page ids, so its cost is bounded by the window and
 * not by the corpus. All windows commit together (one transaction), and the
 * result matches what the one-statement version would have written.
 * Regression it catches: one UPDATE over all of content_chunks; on a large
 * brain it was cancelled and rolled back, so nothing was ever invalidated and
 * every later run repeated the same doomed statement.
 * Seam: a test-only BEFORE UPDATE trigger costs every chunk row 1 ms, so the
 * whole 3000-chunk corpus costs one statement 3 s against a 1.5 s
 * statement_timeout, as row volume does on a large brain, while a window of
 * five pages costs 0.5 s.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { invalidateStaleSignatureEmbeddingsGuarded, hasSignatureDrift } from '../../src/core/embedding-invalidation.ts';

const d = hasDatabase() ? describe : describe.skip;
const url = process.env.DATABASE_URL;
const previousTimeout = process.env.GBRAIN_STATEMENT_TIMEOUT;
const PAGES = 30;
const CHUNKS_PER_PAGE = 100;

let engine: PostgresEngine;
let slow: PostgresEngine;

async function counts(): Promise<{ embedded: number; total: number; restamped: number }> {
  const [row] = await engine.executeRaw<{ embedded: number; total: number; restamped: number }>(
    "SELECT count(*) FILTER (WHERE embedding IS NOT NULL)::int AS embedded, count(*)::int AS total, (SELECT count(*)::int FROM pages WHERE embedding_signature = 'target:model:1') AS restamped FROM content_chunks");
  return row!;
}

async function seed(): Promise<void> {
  for (let i = 0; i < PAGES; i++) await engine.putPage('corpus-' + i, { type: 'note', title: 'corpus ' + i, compiled_truth: 'corpus' });
  const [{ dim }] = await engine.executeRaw<{ dim: number }>(
    "SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0");
  await engine.executeRaw(
    "INSERT INTO content_chunks (page_id, chunk_index, chunk_text, token_count, embedding, embedded_at, model, embedded_text_hash) " +
    "SELECT p.id, g, 'corpus chunk ' || p.slug || ' ' || g, 3, ('[' || array_to_string(array_fill(0.1::real, ARRAY[$1::int]), ',') || ']')::vector, now(), 'old:model', md5('corpus chunk ' || p.slug || ' ' || g) " +
    "FROM pages p, generate_series(0, $2::int - 1) g WHERE p.slug LIKE 'corpus-%' ORDER BY p.id, g", [dim, CHUNKS_PER_PAGE]);
  await engine.executeRaw("UPDATE pages SET embedding_signature = 'old:model:" + "' || $1::text, text_projection_revision = knowledge_revision WHERE slug LIKE 'corpus-%'", [String(dim)]);
}

d('#7148 stale-signature invalidation under statement_timeout (Postgres)', () => {
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(url!);
    engine = await setupDB();
    await engine.executeRaw("CREATE OR REPLACE FUNCTION gbrain_test_row_cost() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.001); RETURN NEW; END $$");
    process.env.GBRAIN_STATEMENT_TIMEOUT = '1500ms';
    slow = new PostgresEngine();
    await slow.connect({ engine: 'postgres', database_url: url!, poolSize: 2 });
  }, 60_000);

  afterAll(async () => {
    if (previousTimeout === undefined) delete process.env.GBRAIN_STATEMENT_TIMEOUT; else process.env.GBRAIN_STATEMENT_TIMEOUT = previousTimeout;
    await engine?.executeRaw('DROP TRIGGER IF EXISTS gbrain_test_row_cost ON content_chunks');
    await engine?.executeRaw('DROP FUNCTION IF EXISTS gbrain_test_row_cost()');
    await slow?.disconnect();
    await teardownDB();
  });

  beforeEach(async () => {
    await engine.executeRaw('DROP TRIGGER IF EXISTS gbrain_test_row_cost ON content_chunks');
    await engine.executeRaw('TRUNCATE pages CASCADE');
  });

  test('a full-corpus model swap is invalidated window by window inside the timeout', async () => {
    await seed();
    expect(await counts()).toMatchObject({ embedded: PAGES * CHUNKS_PER_PAGE, total: PAGES * CHUNKS_PER_PAGE });
    expect(await hasSignatureDrift(slow, { signature: 'target:model:1' })).toBe(true);
    await engine.executeRaw('CREATE TRIGGER gbrain_test_row_cost BEFORE UPDATE ON content_chunks FOR EACH ROW EXECUTE FUNCTION gbrain_test_row_cost()');
    const invalidated = await invalidateStaleSignatureEmbeddingsGuarded(slow, { signature: 'target:model:1', pageBatch: 5 });
    expect(invalidated).toBe(PAGES * CHUNKS_PER_PAGE);
    expect(await counts()).toMatchObject({ embedded: 0, restamped: 0 });
    expect(await hasSignatureDrift(slow, { signature: 'target:model:1' })).toBe(false);
  }, 60_000);

  test('a window that still outruns the timeout rolls every window back', async () => {
    await seed();
    await engine.executeRaw('CREATE TRIGGER gbrain_test_row_cost BEFORE UPDATE ON content_chunks FOR EACH ROW EXECUTE FUNCTION gbrain_test_row_cost()');
    const error = await invalidateStaleSignatureEmbeddingsGuarded(slow, { signature: 'target:model:1', pageBatch: PAGES }).then(() => null, (e: unknown) => e);
    expect(String((error as Error | null)?.message)).toMatch(/statement timeout/);
    expect(await counts()).toMatchObject({ embedded: PAGES * CHUNKS_PER_PAGE });
  }, 60_000);
});
