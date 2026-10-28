/**
 * #7108 on Postgres: migration v221 (chunk_embedding_pending_since) stamped
 * every chunk without a vector in one UPDATE inside the runner's single
 * migration transaction. On a large brain that statement outlived the fixed
 * statement budget on every attempt, rolled back, and left the brain at
 * schema 220. The runner now runs v221's prelude first: it adds the column and
 * stamps the rows in committed, bounded batches, so no statement scales with
 * the table and an interrupted run resumes. v221's published SQL then runs
 * unchanged and finds nothing left to write.
 *
 * The budget is forced low and a trigger makes each stamped row cost about a
 * millisecond, so the published single statement over 3,000 rows exceeds the
 * budget while a 200-row batch stays far inside it.
 * Each case resets one scratch database to "applied v220, not v221". The other
 * preludes (v011, v028, v033, v116, v161) are checked on the same database:
 * rows put back in the state their migration backfills, the prelude writes
 * them in batches, and the published migration SQL afterwards rewrites none.
 * Run: DATABASE_URL=... bun test test/e2e/migration-v221-batched-backfill-7108.test.ts
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrationSQL, runMigrations } from '../../src/core/migrate.ts';
import { MIGRATION_TIMEOUT_KEY, readMigrationTimeout, setMigrationStatementTimeoutMs } from '../../src/core/migration-timeout.ts';
import { migrationTimeoutAdvice } from '../../src/core/migration-timeout-advice.ts';
import { __setBackfillBatchRowsForTests, MIGRATION_PRELUDES, runMigrationPrelude } from '../../src/core/migration-preludes.ts';
import { schemaPendingError } from '../../src/commands/apply-migrations-schema.ts';

const DATABASE_URL = process.env.DATABASE_URL;
const describeE2E = DATABASE_URL ? describe : describe.skip;
const v221 = MIGRATIONS.find(m => m.version === 221)!;
const STAMP_KEY = 'embedding_pending_since_backfilled_at';

let scratchName = '';
let admin: ReturnType<typeof postgres> | null = null;
let engine: PostgresEngine | null = null;
let backoff: string | undefined;

const sql = <T = Record<string, unknown>>(query: string, params: unknown[] = []) => engine!.executeRaw<T>(query, params);

/** Reset to a brain that applied v220 and not v221: no column, no provenance stamp, `rows` chunks of which every tenth has a vector. */
async function stuckAt220(rows: number): Promise<void> {
  await sql('DROP TRIGGER IF EXISTS slow_stamp_7108 ON content_chunks');
  await sql('DROP TRIGGER IF EXISTS fault_7108 ON content_chunks');
  await sql('DELETE FROM content_chunks');
  await sql('ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_pending_since');
  await sql('DELETE FROM config WHERE key = ANY($1::text[])', [[STAMP_KEY, 'search_embedding_column']]);
  const [{ type }] = await sql<{ type: string }>(`SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
    WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`);
  const dims = Number(/\((\d+)\)/.exec(type)![1]);
  const [page] = await sql<{ id: number }>(`INSERT INTO pages (slug, type, title) VALUES ('bench-7108/page', 'note', 'page')
    ON CONFLICT (source_id, slug) DO UPDATE SET title = EXCLUDED.title RETURNING id`);
  await sql(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, embedding, created_at)
    SELECT $1, g, 'chunk ' || g, CASE WHEN g % 10 = 0 THEN array_fill(0.1::real, ARRAY[$3::int])::${type} END, now() - make_interval(mins => g)
      FROM generate_series(1, $2::int) g`, [page!.id, rows, dims]);
  await sql(`INSERT INTO config (key, value) VALUES ('version', '220') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
}

/** About a millisecond per row whose embedding_pending_since changes; rows the statement leaves alone cost nothing. */
async function slowStamping(): Promise<void> {
  await sql(`CREATE OR REPLACE FUNCTION slow_stamp_7108() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF (to_jsonb(NEW) -> 'embedding_pending_since') IS DISTINCT FROM (to_jsonb(OLD) -> 'embedding_pending_since') THEN
        PERFORM pg_sleep(0.001);
      END IF;
      RETURN NEW;
    END $$`);
  await sql('CREATE TRIGGER slow_stamp_7108 BEFORE UPDATE ON content_chunks FOR EACH ROW EXECUTE FUNCTION slow_stamp_7108()');
}

async function version(): Promise<number> {
  return Number(await engine!.getConfig('version'));
}

/** Chunks missing a vector that are not stamped with their created_at, and stamped chunks that have one. */
async function wrongStamps(column = 'embedding'): Promise<{ missing: number; extra: number }> {
  const [row] = await sql<{ missing: number; extra: number }>(`SELECT
      count(*) FILTER (WHERE "${column}" IS NULL AND embedding_pending_since IS DISTINCT FROM created_at)::int AS missing,
      count(*) FILTER (WHERE "${column}" IS NOT NULL AND embedding_pending_since IS NOT NULL)::int AS extra
    FROM content_chunks`);
  return row!;
}

/** Run the published migration SQL and return the ids of `table` rows it rewrote (xmin changed). */
async function rewrittenBy(version: number, table: string): Promise<number[]> {
  const before = await sql<{ id: number; xmin: string }>(`SELECT id, xmin::text AS xmin FROM ${table}`);
  const m = MIGRATIONS.find(x => x.version === version)!;
  await runMigrationSQL(engine!, m, m.sqlFor?.postgres ?? m.sql);
  const after = new Map((await sql<{ id: number; xmin: string }>(`SELECT id, xmin::text AS xmin FROM ${table}`)).map(r => [Number(r.id), r.xmin]));
  return before.filter(r => after.get(Number(r.id)) !== r.xmin).map(r => Number(r.id));
}

/** Distinct writing transactions among the rows: more than one means the prelude committed more than one batch. */
async function writers(table: string, where = 'true'): Promise<number> {
  const [row] = await sql<{ n: number }>(`SELECT count(DISTINCT xmin::text)::int AS n FROM ${table} WHERE ${where}`);
  return Number(row!.n);
}

describeE2E('#7108: v221 backfills in resumable batches (Postgres)', () => {
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(DATABASE_URL!);
    backoff = process.env.GBRAIN_MIGRATE_BACKOFF_MS;
    process.env.GBRAIN_MIGRATE_BACKOFF_MS = '0';
    scratchName = `gbrain_test_v221_${randomUUID().replaceAll('-', '')}`;
    admin = postgres(DATABASE_URL!, { max: 1, prepare: false });
    await admin.unsafe(`CREATE DATABASE ${scratchName}`);
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${scratchName}`;
    engine = new PostgresEngine();
    await engine.connect({ database_url: url.toString() });
    await engine.initSchema();
  }, 180_000);

  afterEach(() => {
    setMigrationStatementTimeoutMs(null);
    __setBackfillBatchRowsForTests(null);
  });

  afterAll(async () => {
    await engine?.disconnect();
    if (admin) {
      await admin.unsafe(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`);
      await admin.end();
    }
    if (backoff === undefined) delete process.env.GBRAIN_MIGRATE_BACKOFF_MS;
    else process.env.GBRAIN_MIGRATE_BACKOFF_MS = backoff;
  });

  test('a backfill that outlives the statement budget as one statement completes in batches', async () => {
    await stuckAt220(3_000);
    await slowStamping();
    setMigrationStatementTimeoutMs(1_500);
    __setBackfillBatchRowsForTests(200);

    // The published single statement exceeds the budget and rolls back, column included.
    const single = await runMigrationSQL(engine!, v221, v221.sql).then(() => null, (error: unknown) => error as { code?: string });
    expect(single?.code).toBe('57014');
    expect(await sql(`SELECT 1 FROM information_schema.columns WHERE table_name = 'content_chunks' AND column_name = 'embedding_pending_since'`)).toHaveLength(0);

    // The runner gets the brain to head under the same budget.
    await runMigrations(engine!);
    expect(await version()).toBe(LATEST_VERSION);
    expect(await wrongStamps()).toEqual({ missing: 0, extra: 0 });
    const [{ stamped }] = await sql<{ stamped: number }>('SELECT count(*)::int AS stamped FROM content_chunks WHERE embedding_pending_since IS NOT NULL');
    expect(stamped).toBe(2_700);
    expect(await engine!.getConfig(STAMP_KEY)).toBeTruthy();
  }, 120_000);

  test('an interrupted backfill keeps its committed batches and resumes without rewriting them', async () => {
    await stuckAt220(2_000);
    __setBackfillBatchRowsForTests(200);
    const [{ fault }] = await sql<{ fault: number }>('SELECT id AS fault FROM content_chunks ORDER BY id OFFSET 1100 LIMIT 1');
    await sql(`CREATE OR REPLACE FUNCTION fault_7108() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected interruption at chunk %', NEW.id; END $$`);
    await sql(`CREATE TRIGGER fault_7108 BEFORE UPDATE ON content_chunks FOR EACH ROW WHEN (NEW.id = ${fault}) EXECUTE FUNCTION fault_7108()`);

    await expect(runMigrations(engine!)).rejects.toThrow(/injected interruption/);
    expect(await version()).toBe(220);
    const [done] = await sql<{ stamped: number; max_id: number | null; after: number }>(`SELECT
        count(*) FILTER (WHERE embedding_pending_since IS NOT NULL)::int AS stamped,
        max(id) FILTER (WHERE embedding_pending_since IS NOT NULL) AS max_id,
        count(*) FILTER (WHERE id >= $1 AND embedding_pending_since IS NOT NULL)::int AS after
      FROM content_chunks`, [fault]);
    // Five committed batches of 200 ids (1,000 rows, 900 without a vector); the sixth, holding the fault, rolled back.
    expect(done!.stamped).toBe(900);
    expect(done!.after).toBe(0);
    const firstStamp = await engine!.getConfig(STAMP_KEY);
    expect(firstStamp).toBeTruthy();
    const before = await sql<{ id: number; xmin: string }>('SELECT id, xmin::text AS xmin FROM content_chunks WHERE embedding_pending_since IS NOT NULL ORDER BY id');

    await sql('DROP TRIGGER fault_7108 ON content_chunks');
    await runMigrations(engine!);
    expect(await version()).toBe(LATEST_VERSION);
    expect(await wrongStamps()).toEqual({ missing: 0, extra: 0 });
    // The rows the first run stamped were not written again, and the provenance stamp kept its first value.
    const after = await sql<{ id: number; xmin: string }>('SELECT id, xmin::text AS xmin FROM content_chunks WHERE id = ANY($1::int[]) ORDER BY id', [before.map(r => r.id)]);
    expect(after).toEqual(before);
    expect(await engine!.getConfig(STAMP_KEY)).toBe(firstStamp);
  }, 120_000);

  test('a brain stuck at 220 upgrades to head and stamps against the active embedding column', async () => {
    await stuckAt220(1_000);
    await sql('ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_alt_7108 vector(3)');
    await sql(`UPDATE content_chunks SET embedding_alt_7108 = '[1,2,3]' WHERE chunk_index % 4 = 0`);
    await sql(`INSERT INTO config (key, value) VALUES ('search_embedding_column', 'embedding_alt_7108')`);

    await runMigrations(engine!);
    expect(await version()).toBe(LATEST_VERSION);
    expect(await wrongStamps('embedding_alt_7108')).toEqual({ missing: 0, extra: 0 });
    await sql(`DELETE FROM config WHERE key = 'search_embedding_column'`);
    await sql('ALTER TABLE content_chunks DROP COLUMN embedding_alt_7108');
  }, 120_000);

  test('a search_embedding_column naming no column falls back to embedding, as v221 does', async () => {
    await stuckAt220(500);
    await sql(`INSERT INTO config (key, value) VALUES ('search_embedding_column', 'no_such_column_7108')`);
    await runMigrations(engine!);
    expect(await version()).toBe(LATEST_VERSION);
    expect(await wrongStamps()).toEqual({ missing: 0, extra: 0 });
    await sql(`DELETE FROM config WHERE key = 'search_embedding_column'`);
  }, 120_000);

  test('a brain with no chunk missing a vector records no backfill stamp', async () => {
    await stuckAt220(0);
    await runMigrations(engine!);
    expect(await version()).toBe(LATEST_VERSION);
    expect(await engine!.getConfig(STAMP_KEY)).toBeNull();
  }, 120_000);

  test('a timeout is recorded with the next step; a run with a longer budget applies the migration and clears it', async () => {
    await stuckAt220(3_000);
    await slowStamping();
    setMigrationStatementTimeoutMs(1_500);
    __setBackfillBatchRowsForTests(3_000);

    await expect(runMigrations(engine!)).rejects.toThrow(/v221/);
    expect(await version()).toBe(220);
    const record = await readMigrationTimeout(engine!, 220);
    expect(record).toMatchObject({ version: 221, name: 'chunk_embedding_pending_since', batched: true, idle_pids: [] });
    const advice = migrationTimeoutAdvice(record!, { argv: ['gbrain', 'doctor', '--json'] });
    expect(advice.fix.ask_user).toBe(true);
    expect(advice.fix.argv).toEqual(['gbrain', 'apply-migrations', '--yes', '--statement-timeout', '120']);
    const failure = schemaPendingError({ reason: 'still_behind', current: 220, latest: LATEST_VERSION, pending: [221], timeout: record! },
      { consent: [], actor: 'agent', why: 'unused', requires_exclusive: false });
    expect(failure.code).toBe('migrations_pending');
    expect(failure.message).toContain('v221 (chunk_embedding_pending_since)');
    expect(failure.fix?.argv).toContain('--statement-timeout');

    setMigrationStatementTimeoutMs(0);
    await runMigrations(engine!);
    expect(await version()).toBe(LATEST_VERSION);
    expect(await wrongStamps()).toEqual({ missing: 0, extra: 0 });
    expect(await engine!.getConfig(MIGRATION_TIMEOUT_KEY)).toBeNull();
  }, 120_000);

  describe('the other published backfills run in batches first', () => {
  let pageId = 0;
  let chunkIds: number[] = [];

  beforeAll(async () => {
    await stuckAt220(0);
    await runMigrations(engine!);
    const [page] = await sql<{ id: number }>(`SELECT id FROM pages WHERE slug = 'bench-7108/page'`);
    pageId = Number(page!.id);
    await sql(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, doc_comment, symbol_name_qualified)
      SELECT $1, g, 'text ' || g, CASE WHEN g % 3 = 0 THEN 'doc ' || g END, CASE WHEN g % 5 = 0 THEN 'mod.fn' || g END
        FROM generate_series(1, 50) g`, [pageId]);
    chunkIds = (await sql<{ id: number }>('SELECT id FROM content_chunks ORDER BY id')).map(r => Number(r.id));
  }, 120_000);

  beforeEach(() => __setBackfillBatchRowsForTests(7));

  test('every prelude names a registered migration', () => {
    const versions = new Set(MIGRATIONS.map(m => m.version));
    for (const version of MIGRATION_PRELUDES.keys()) expect(versions.has(version)).toBe(true);
  });

  test('v028 chunk keyword vectors', async () => {
    const expected = `setweight(to_tsvector('english', COALESCE(doc_comment, '')), 'A') || setweight(to_tsvector('english', COALESCE(symbol_name_qualified, '')), 'A') || setweight(to_tsvector('english', COALESCE(chunk_text, '')), 'B')`;
    await sql('UPDATE content_chunks SET search_vector = NULL');
    await runMigrationPrelude(engine!, 28);
    expect(await writers('content_chunks')).toBeGreaterThan(1);
    const [row] = await sql<{ wrong: number }>(`SELECT count(*)::int AS wrong FROM content_chunks WHERE search_vector IS DISTINCT FROM (${expected})`);
    expect(row!.wrong).toBe(0);
    expect(await rewrittenBy(28, 'content_chunks')).toEqual([]);
  });

  test('v033 request-log agent names', async () => {
    await sql(`INSERT INTO oauth_clients (client_id, client_name) VALUES ('client-7108', 'Agent Example') ON CONFLICT DO NOTHING`);
    await sql(`INSERT INTO mcp_request_log (token_name, operation)
      SELECT CASE g % 3 WHEN 0 THEN 'client-7108' WHEN 1 THEN 'raw-token-' || g END, 'search' FROM generate_series(1, 40) g`);
    await sql('UPDATE mcp_request_log SET agent_name = NULL');
    await runMigrationPrelude(engine!, 33);
    expect(await writers('mcp_request_log', 'token_name IS NOT NULL')).toBeGreaterThan(1);
    const names = await sql<{ token_name: string | null; agent_name: string | null }>('SELECT token_name, agent_name FROM mcp_request_log');
    for (const r of names) expect(r.agent_name).toBe(r.token_name === 'client-7108' ? 'Agent Example' : r.token_name);
    // A row with no token resolves to NULL, so v033's own predicate keeps selecting it; only those are rewritten.
    const unresolved = (await sql<{ id: number }>('SELECT id FROM mcp_request_log WHERE token_name IS NULL ORDER BY id')).map(r => Number(r.id));
    expect(unresolved.length).toBeGreaterThan(0);
    expect((await rewrittenBy(33, 'mcp_request_log')).sort((a, b) => a - b)).toEqual(unresolved);
  });

  test('v116 code edge sources', async () => {
    await sql(`INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type)
      SELECT id, 'a', 'b' || id, 'calls' FROM content_chunks`);
    await sql(`INSERT INTO code_edges_chunk (from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type)
      SELECT id, $1, 'a', 'b' || id, 'calls' FROM content_chunks`, [chunkIds[0]]);
    await sql('UPDATE code_edges_symbol SET source_id = NULL');
    await sql('UPDATE code_edges_chunk SET source_id = NULL');
    await runMigrationPrelude(engine!, 116);
    expect(await writers('code_edges_symbol')).toBeGreaterThan(1);
    for (const table of ['code_edges_symbol', 'code_edges_chunk']) {
      const [row] = await sql<{ wrong: number }>(`SELECT count(*)::int AS wrong FROM ${table} WHERE source_id IS DISTINCT FROM 'default'`);
      expect(row!.wrong).toBe(0);
    }
    expect(await rewrittenBy(116, 'code_edges_symbol')).toEqual([]);
  });

  test('v011 legacy link sources', async () => {
    const [other] = await sql<{ id: number }>(`INSERT INTO pages (slug, type, title) VALUES ('bench-7108/other', 'note', 'other')
      ON CONFLICT (source_id, slug) DO UPDATE SET title = EXCLUDED.title RETURNING id`);
    await sql(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
      SELECT $1, $2, 'mentions-' || g, NULL FROM generate_series(1, 30) g`, [pageId, other!.id]);
    await runMigrationPrelude(engine!, 11);
    expect(await writers('links')).toBeGreaterThan(1);
    const [row] = await sql<{ wrong: number }>(`SELECT count(*)::int AS wrong FROM links WHERE link_source IS DISTINCT FROM 'markdown'`);
    expect(row!.wrong).toBe(0);
    expect(await rewrittenBy(11, 'links')).toEqual([]);
  });

  test('v161 builds the pending-projection index without the migration\'s 30-second cap', async () => {
    await sql('DROP INDEX IF EXISTS idx_pages_projection_pending');
    await runMigrationPrelude(engine!, 161);
    // An INVALID leftover (an interrupted concurrent build) is dropped and rebuilt, never accepted.
    await sql(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = to_regclass('idx_pages_projection_pending')`);
    await runMigrationPrelude(engine!, 161);
    const [idx] = await sql<{ valid: boolean }>(`SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = to_regclass('idx_pages_projection_pending')`);
    expect(idx?.valid).toBe(true);
    const m = MIGRATIONS.find(x => x.version === 161)!;
    await runMigrationSQL(engine!, m, m.sqlFor!.postgres!);
  });
  });
});
