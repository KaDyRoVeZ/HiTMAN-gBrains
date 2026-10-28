/**
 * #5730: the debounced legacy-token `last_used_at` UPDATE is fire-and-forget,
 * so a row lock held elsewhere never delayed verification, but the UPDATE
 * itself parked a pooled connection on the lock until statement_timeout.
 * Both sites (OAuth provider legacy fallback and the legacy HTTP transport)
 * now skip a locked row.
 *
 * Protects: a locked token row leaves no backend waiting on that lock after
 * authentication. Regression that fails it: dropping SKIP LOCKED from either
 * UPDATE. Existing coverage checks the 60 s debounce only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import postgres from '#postgres';
import { startHttpTransport } from '../../src/mcp/http-transport.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { hashToken } from '../../src/core/utils.ts';
import { hasDatabase, setupDB, teardownDB, getEngine, getConn } from './helpers.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;

describeE2E('#5730 token usage UPDATE skips a locked row', () => {
  let locker: postgres.Sql;
  let release: (() => void) | null = null;

  beforeAll(async () => {
    await setupDB();
    locker = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });
  });
  afterEach(() => { release?.(); release = null; });
  afterAll(async () => {
    await locker?.end({ timeout: 1 });
    await teardownDB();
  });

  async function seedLockedToken(): Promise<string> {
    const token = 'gbrain_test_' + randomBytes(16).toString('hex');
    await getConn().unsafe('INSERT INTO access_tokens (name, token_hash) VALUES ($1, $2)',
      ['skip-locked-' + randomBytes(4).toString('hex'), hashToken(token)]);
    let locked!: () => void;
    const held = new Promise<void>(resolve => { locked = resolve; });
    const done = new Promise<void>(resolve => { release = resolve; });
    void locker.begin(async tx => {
      await tx`SELECT id FROM access_tokens WHERE token_hash = ${hashToken(token)} FOR UPDATE`;
      locked();
      await done;
    });
    await held;
    return token;
  }

  async function backendsWaitingOnTokenUpdate(): Promise<number> {
    await Bun.sleep(400);
    const rows = await getConn().unsafe(`
      SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND query ILIKE '%UPDATE access_tokens%'`);
    return rows[0].n as number;
  }

  test('OAuth provider legacy-token fallback', async () => {
    const engine = getEngine();
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const token = await seedLockedToken();
    const started = Date.now();
    const auth = await provider.verifyAccessToken(token);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(auth.token).toBe(token);
    expect(await backendsWaitingOnTokenUpdate()).toBe(0);
  });

  test('legacy HTTP transport bearer validation', async () => {
    const server = await startHttpTransport({ port: 0, engine: getEngine() as never });
    try {
      const token = await seedLockedToken();
      const res = await fetch(`http://localhost:${(server as { port: number }).port}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      expect(res.status).toBe(200);
      expect(await backendsWaitingOnTokenUpdate()).toBe(0);
    } finally {
      (server as { stop: (force: boolean) => void }).stop(true);
    }
  });
});
