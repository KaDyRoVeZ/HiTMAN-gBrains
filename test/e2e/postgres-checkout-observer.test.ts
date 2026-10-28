/**
 * #5801: the engine's checkout observer fires only once a connection is
 * actually obtained (reserve resolution or transaction-callback entry), never
 * while a call is still waiting for a pool slot. The persistence consumer
 * builds its first_conn_ms / checkout=not_observed evidence on this seam.
 *
 * Regression that fails it: firing at the gauge's acquire() (before the wait),
 * or not firing on one of the three acquisition paths.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const url = process.env.DATABASE_URL;
let engine: PostgresEngine | undefined;
afterEach(async () => { await engine?.disconnect(); engine = undefined; });

async function connect(poolSize: number): Promise<{ engine: PostgresEngine; checkouts: () => number }> {
  assertSafeE2eDatabaseUrl(url!);
  engine = new PostgresEngine();
  await engine.connect({ engine: 'postgres', database_url: url!, poolSize });
  let count = 0;
  engine.onCheckout(() => { count++; });
  return { engine, checkouts: () => count };
}

describe.skipIf(!url)('#5801 engine checkout observer', () => {
  test('fires once per acquisition on the signalled raw, transaction and reserved paths, never for unsignalled pooled queries', async () => {
    const { engine, checkouts } = await connect(3);
    await engine.executeRaw('SELECT 1');
    expect(checkouts()).toBe(0);
    await engine.executeRaw('SELECT 1', undefined, { signal: new AbortController().signal });
    expect(checkouts()).toBe(1);
    await engine.transaction(async tx => { expect(checkouts()).toBe(2); await tx.executeRaw('SELECT 1'); });
    await engine.withReservedConnection(async conn => { expect(checkouts()).toBe(3); await conn.executeRaw('SELECT 1'); });
    expect(checkouts()).toBe(3);
  });

  test('a call waiting for a pool slot is not observed until it obtains one', async () => {
    const { engine, checkouts } = await connect(2);
    const release = Promise.withResolvers<void>();
    let held = 0;
    const holding = Array.from({ length: 2 }, () => engine.transaction(async tx => {
      await tx.executeRaw('SELECT 1'); held++; await release.promise;
    }));
    while (held < 2) await Bun.sleep(5);
    expect(checkouts()).toBe(2);
    const waiting = engine.executeRaw('SELECT 1', undefined, { signal: new AbortController().signal });
    await Bun.sleep(200);
    expect(checkouts()).toBe(2);
    release.resolve();
    await Promise.all(holding);
    await waiting;
    expect(checkouts()).toBe(3);
  });
});
