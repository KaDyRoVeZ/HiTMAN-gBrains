/**
 * A lock held across `engine.reconnect()` still releases its own row.
 *
 * A write admission that loses its connection rebuilds the engine's pool (`retryWriteAdmission` calls
 * `engine.reconnect`), and the rebuild ends the pool the lock was acquired on. The handle's release ran its DELETE on
 * that ended pool, so `withRefreshingLock` threw `CONNECTION_ENDED` after the work finished and the row stayed until
 * its TTL lapsed (test/managed-sync-connection-loss.test.ts failed this way when an admit-ahead admission landed inside
 * the simulated pooler drop).
 *
 * Runs on PGLite and, with DATABASE_URL, on Postgres.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { tryAcquireDbLock, withRefreshingLock } from '../src/core/db-lock.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const engines: Array<{ engine: BrainEngine; close: () => Promise<void> }> = [];
const connectionClosed = () => Object.assign(new Error('write CONNECTION_CLOSED 127.0.0.1:6543'), { code: 'CONNECTION_CLOSED' });

beforeAll(async () => {
  for (const backend of testBackends()) {
    if (backend === 'pglite') {
      const engine = new PGLiteEngine();
      await engine.connect({ database_url: '' });
      await engine.initSchema();
      engines.push({ engine, close: () => engine.disconnect() });
    } else {
      engines.push(await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    }
  }
}, 120_000);

afterAll(async () => {
  for (const e of engines) await e.close();
});

const lockRow = async (engine: BrainEngine, id: string) =>
  (await engine.executeRaw('SELECT acquisition_token::text AS token FROM gbrain_cycle_locks WHERE id = $1', [id]))[0] ?? null;

test('release after a reconnect deletes the lock row on the live pool', async () => {
  for (const { engine } of engines) {
    const handle = await tryAcquireDbLock(engine, 'test-reconnect-release', 5);
    expect(handle).not.toBeNull();
    await engine.reconnect({ error: connectionClosed() });
    expect(await handle!.refresh()).toBe(true);
    await handle!.release();
    expect(await lockRow(engine, 'test-reconnect-release')).toBeNull();
  }
});

test('withRefreshingLock returns the work result when the pool is rebuilt mid-hold', async () => {
  for (const { engine } of engines) {
    const result = await withRefreshingLock(engine, 'test-reconnect-hold', async () => {
      await engine.reconnect({ error: connectionClosed() });
      return 'done';
    });
    expect(result).toBe('done');
    expect(await lockRow(engine, 'test-reconnect-hold')).toBeNull();
  }
});
