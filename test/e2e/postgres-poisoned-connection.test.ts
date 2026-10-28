/**
 * #5730: a pooled or released connection whose ReadyForQuery status is not idle
 * (`T` in a transaction, `E` in a failed transaction) must never serve another
 * caller. Before the driver fix such a connection returned to the pool, so one
 * leaked transaction turned every later pooled statement into 25P02 until the
 * process restarted.
 *
 * Protects: the next pooled statement after a leaked transaction runs outside
 * it; the driver reports each discard through `onpoisoned`; the engine counts
 * it in `getPoolDiagnostics().poisonedDiscards` and logs one redacted warn line.
 * Regression that fails it: returning a non-idle connection to the pool on
 * either the pooled ReadyForQuery path or the reserved-release path.
 * Existing coverage (persistence-chaos) pins cancellation ownership only.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { createRequire } from 'node:module';
import postgres from '#postgres';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const url = process.env.DATABASE_URL;
const opened: Array<{ end: (o?: { timeout?: number }) => Promise<void> }> = [];

afterEach(async () => {
  while (opened.length) await opened.pop()!.end({ timeout: 1 }).catch(() => {});
});

function pool(max: number, statuses: string[], driver: typeof postgres = postgres, appName = `gbrain-5730-${Math.random().toString(36).slice(2)}`) {
  assertSafeE2eDatabaseUrl(url!);
  const sql = driver(url!, {
    max,
    onnotice: () => {},
    connection: { application_name: appName },
    onpoisoned: (status: string) => { statuses.push(status); },
  } as Parameters<typeof postgres>[1]);
  opened.push(sql);
  return { sql, appName };
}

function failure(query: PromiseLike<unknown>): Promise<{ code?: string }> {
  return Promise.resolve(query).then(() => ({ code: 'resolved' }), (error: { code?: string }) => error);
}

async function autocommit(sql: postgres.Sql): Promise<boolean> {
  const [a] = await sql`SELECT txid_current()::text AS x`;
  const [b] = await sql`SELECT txid_current()::text AS x`;
  return a.x !== b.x;
}

async function idleInTransaction(observer: postgres.Sql, appName: string): Promise<number> {
  const [row] = await observer`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE application_name = ${appName} AND state LIKE 'idle in transaction%'`;
  return row.n as number;
}

describe.skipIf(!url)('#5730 poisoned pooled connections are discarded', () => {
  test('reservation released inside a failed transaction (pool of 1) does not poison the next query', async () => {
    const statuses: string[] = [];
    const { sql } = pool(1, statuses);
    const reserved = await sql.reserve();
    await reserved`BEGIN`;
    expect((await failure(reserved`SELECT 1/0`)).code).toBe('22012');
    reserved.release();
    expect(await autocommit(sql)).toBe(true);
    expect(statuses).toEqual(['E']);
  });

  test('a query queued behind the discarded connection runs on a fresh connection', async () => {
    const statuses: string[] = [];
    const { sql } = pool(1, statuses);
    const reserved = await sql.reserve();
    const queued = sql`SELECT 2 AS ok`.execute();
    await reserved`BEGIN`;
    reserved.release();
    expect((await queued)[0]).toEqual({ ok: 2 });
    expect(await autocommit(sql)).toBe(true);
    expect(statuses).toEqual(['T']);
  });

  test('pooled connection left in a transaction by a rejected BEGIN never serves later statements', async () => {
    const statuses: string[] = [];
    const { sql, appName } = pool(2, statuses);
    const observer = postgres(url!, { max: 1, onnotice: () => {} });
    opened.push(observer);
    expect((await failure(sql.unsafe('BEGIN'))).code).toBe('UNSAFE_TRANSACTION');
    for (let i = 0; i < 6; i++) {
      expect((await failure(sql`SELECT 1/0`)).code).toBe('22012');
      const [row] = await sql`SELECT ${i}::int AS i`;
      expect(row).toEqual({ i });
    }
    expect(await idleInTransaction(observer, appName)).toBe(0);
    expect(statuses).toEqual(['T']);
  });

  test('CommonJS build applies the same discard', async () => {
    const cjs = createRequire(import.meta.url)('#postgres') as typeof postgres;
    expect(cjs).not.toBe(postgres);
    const statuses: string[] = [];
    const { sql } = pool(1, statuses, cjs);
    const reserved = await sql.reserve();
    await reserved`BEGIN`;
    reserved.release();
    expect(await autocommit(sql)).toBe(true);
    expect(statuses).toEqual(['T']);
  });

  test('a max-1 pool keeps the documented raw BEGIN idiom', async () => {
    const statuses: string[] = [];
    const { sql } = pool(1, statuses);
    await sql`BEGIN`;
    const [a] = await sql`SELECT txid_current()::text AS x`;
    const [b] = await sql`SELECT txid_current()::text AS x`;
    await sql`COMMIT`;
    expect(a.x).toBe(b.x);
    expect(statuses).toEqual([]);
  });

  test('engine (pool of 2, the long-hold minimum) counts each discard once and logs one redacted warn line', async () => {
    assertSafeE2eDatabaseUrl(url!);
    const engine = new PostgresEngine();
    await engine.connect({ engine: 'postgres', database_url: url!, poolSize: 2 });
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await engine.withReservedConnection(async conn => {
        await conn.executeRaw('BEGIN');
        expect((await failure(conn.executeRaw('SELECT 1/0'))).code).toBe('22012');
      });
      const ids = new Set<string>();
      for (let i = 0; i < 4; i++) {
        const rows = await engine.executeRaw<{ x: string }>('SELECT txid_current()::text AS x');
        ids.add(rows[0].x);
      }
      expect(ids.size).toBe(4);
      expect(engine.getPoolDiagnostics()?.poisonedDiscards).toBe(1);
      const lines = warn.mock.calls.map(c => String(c[0])).filter(l => l.includes('pg_connection_poisoned'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('status=E');
      expect(lines[0]).not.toContain(url!);
      expect(lines[0].length).toBeLessThanOrEqual(400);
    } finally {
      warn.mockRestore();
      await engine.disconnect();
    }
  });
});
