/**
 * #7108 on PGLite: the runner backfills v221 through its prelude on PGLite too.
 * A brain that applied v220 and not v221 reaches head, every chunk without a
 * vector carries its created_at, chunks with one stay unstamped, and the
 * backfill provenance stamp is recorded. The Postgres timeout, interruption
 * and resume cases are in test/e2e/migration-v221-batched-backfill-7108.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';
import { __setBackfillBatchRowsForTests } from '../src/core/migration-preludes.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  __setBackfillBatchRowsForTests(null);
  await engine.disconnect();
});

describe('#7108: v221 prelude on PGLite', () => {
  test('a brain at 220 upgrades to head with v221 stamped in batches', async () => {
    const [{ type }] = await engine.executeRaw<{ type: string }>(`SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
      WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`);
    const dims = Number(/\((\d+)\)/.exec(type)![1]);
    const [page] = await engine.executeRaw<{ id: number }>(`INSERT INTO pages (slug, type, title) VALUES ('prelude-7108/page', 'note', 'page') RETURNING id`);
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, embedding, created_at)
      SELECT $1, g, 'chunk ' || g, CASE WHEN g % 4 = 0 THEN array_fill(0.1::real, ARRAY[$2::int])::${type} END, now() - make_interval(mins => g)
        FROM generate_series(1, 120) g`, [page!.id, dims]);
    await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN embedding_pending_since');
    await engine.executeRaw(`DELETE FROM config WHERE key = 'embedding_pending_since_backfilled_at'`);
    await engine.setConfig('version', '220');
    __setBackfillBatchRowsForTests(25);

    await runMigrations(engine);

    expect(Number(await engine.getConfig('version'))).toBe(LATEST_VERSION);
    const [row] = await engine.executeRaw<{ stamped: number; wrong: number }>(`SELECT
        count(*) FILTER (WHERE embedding IS NULL AND embedding_pending_since = created_at)::int AS stamped,
        count(*) FILTER (WHERE (embedding IS NULL) <> (embedding_pending_since IS NOT NULL))::int AS wrong
      FROM content_chunks`);
    expect(row).toEqual({ stamped: 90, wrong: 0 });
    expect(await engine.getConfig('embedding_pending_since_backfilled_at')).toBeTruthy();
  });
});
