/**
 * #6007: page guards and counter locks on real Postgres, with concurrent
 * transactions on separate pooled connections. A transaction (and its
 * savepoints) never re-acquires a key it holds, including a key whose pages
 * row is absent: the only pages INSERT runs after putPage takes the same
 * guard. lockCounters creates and locks counter sets in key order.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase } from './helpers.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { lockCounters } from '../../src/core/persistence/journal.ts';

const d = hasDatabase() ? describe : describe.skip;
const A = 'guard-src-a', B = 'guard-src-b';
const page = { type: 'note' as const, title: 'Guard fixture', compiled_truth: 'Synthetic guarded body.', timeline: '', frontmatter: {} };

/** Resolves true when the promise settles within the window, false while it is still blocked. */
const settlesWithin = (promise: Promise<unknown>, ms = 400) =>
  Promise.race([promise.then(() => true, () => true), Bun.sleep(ms).then(() => false)]);
/** A transaction held open until `release` resolves. */
function holdTransaction(engine: BrainEngine, body: (tx: BrainEngine) => Promise<void>) {
  let release!: () => void;
  let ready!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { ready = resolve; });
  const done = engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('lock_timeout','15s',true)");
    await body(tx);
    ready();
    await released;
  });
  done.catch(() => ready());
  return { entered, release, done };
}

d('#6007 page guards on Postgres', () => {
  let engine: PostgresEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    for (const id of [A, B]) await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [id]);
    await engine.putPage('present', page, { sourceId: A });
  }, 120_000);
  afterAll(async () => { await close(); });

  test('a missing source refuses with the same error and creates no guard rows', async () => {
    const before = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM page_write_guards');
    await expect(engine.transaction(tx => tx.lockPageKeys([{ sourceId: A, slug: 'fresh-one' }, { sourceId: 'guard-src-missing', slug: 'x' }])))
      .rejects.toThrow('Page source does not exist: guard-src-missing');
    expect(await engine.executeRaw('SELECT count(*)::int AS n FROM page_write_guards')).toEqual(before);
  });

  test('a guard on an absent page blocks another transaction from creating that page until it ends', async () => {
    const holder = holdTransaction(engine, tx => tx.lockPageKeys([{ sourceId: A, slug: 'absent-page' }]));
    await holder.entered;
    const writer = engine.putPage('absent-page', page, { sourceId: A });
    expect(await settlesWithin(writer)).toBe(false);
    expect(await engine.executeRaw("SELECT id FROM pages WHERE source_id=$1 AND slug='absent-page'", [A])).toEqual([]);
    holder.release();
    await holder.done;
    await writer;
    expect((await engine.executeRaw("SELECT id FROM pages WHERE source_id=$1 AND slug='absent-page'", [A])).length).toBe(1);
  });

  test('an existing pages row is locked against direct SQL writers', async () => {
    const holder = holdTransaction(engine, tx => tx.lockPageKeys([{ sourceId: A, slug: 'present' }]));
    await holder.entered;
    const direct = engine.executeRaw("UPDATE pages SET frontmatter='{}'::jsonb WHERE source_id=$1 AND slug='present'", [A]);
    expect(await settlesWithin(direct)).toBe(false);
    holder.release();
    await holder.done;
    await direct;
  });

  test('a rolled-back savepoint releases its new guard and forgets it; the outer transaction locks it again', async () => {
    const key = { sourceId: B, slug: 'savepoint-rollback' };
    const holder = holdTransaction(engine, async tx => {
      await expect(tx.transaction(async child => { await child.lockPageKeys([key]); throw new Error('child rollback'); })).rejects.toThrow('child rollback');
      // Released by the savepoint rollback: another transaction takes it at once.
      expect(await settlesWithin(engine.transaction(other => other.lockPageKeys([key])))).toBe(true);
      // Not remembered as held: this call locks it for real.
      await tx.lockPageKeys([key]);
    });
    await holder.entered;
    const contender = engine.transaction(other => other.lockPageKeys([key]));
    expect(await settlesWithin(contender)).toBe(false);
    holder.release();
    await holder.done;
    await contender;
  });

  test('a released savepoint keeps its guard for the outer transaction until commit', async () => {
    const key = { sourceId: B, slug: 'savepoint-release' };
    const holder = holdTransaction(engine, async tx => {
      await tx.transaction(child => child.lockPageKeys([key]));
      await tx.lockPageKeys([key]);
    });
    await holder.entered;
    const contender = engine.transaction(other => other.lockPageKeys([key]));
    expect(await settlesWithin(contender)).toBe(false);
    holder.release();
    await holder.done;
    await contender;
  });

  test('an outer rollback releases every guard it took', async () => {
    const keys = [{ sourceId: A, slug: 'outer-1' }, { sourceId: B, slug: 'outer-2' }];
    await expect(engine.transaction(async tx => { await tx.lockPageKeys(keys); throw new Error('outer rollback'); })).rejects.toThrow('outer rollback');
    expect(await settlesWithin(engine.transaction(tx => tx.lockPageKeys(keys)))).toBe(true);
  });

  test('pooled transactions keep separate held sets', async () => {
    const key = { sourceId: A, slug: 'pooled' };
    const first = holdTransaction(engine, tx => tx.lockPageKeys([key]));
    await first.entered;
    const second = engine.transaction(tx => tx.lockPageKeys([key]));
    expect(await settlesWithin(second)).toBe(false);
    first.release();
    await first.done;
    await second;
  });

  test('concurrent overlapping multi-source key sets in any input order never deadlock', async () => {
    const all = [A, B].flatMap(sourceId => ['k1', 'k2', 'k3', 'present'].map(slug => ({ sourceId, slug })));
    const shuffled = (seed: number) => [...all].sort((x, y) => ((x.slug.charCodeAt(1) * 31 + x.sourceId.length * seed) % 7) - ((y.slug.charCodeAt(1) * 31 + y.sourceId.length * seed) % 7));
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('lock_timeout','10s',true)");
      const keys = shuffled(i + 1).slice(i % 3, i % 3 + 5);
      await tx.lockPageKeys(keys);
      await Bun.sleep(5);
      // Held keys are not re-acquired, so repeating a subset in another order is free of lock waits.
      await tx.lockPageKeys([...keys].reverse().slice(1));
    })));
    expect(results.filter(r => r.status === 'rejected').map(r => String((r as PromiseRejectedResult).reason))).toEqual([]);
  });
});

d('#6007 counter locks on Postgres', () => {
  let engine: PostgresEngine;
  let close: () => Promise<void>;
  beforeAll(async () => { ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!)); }, 120_000);
  afterAll(async () => { await close(); });

  test('simultaneous first creation of overlapping counter sets creates each row once and serializes every holder', async () => {
    const keySets = Array.from({ length: 10 }, (_, i) => ['brain', `counter:${i % 3}`, `counter:${(i + 1) % 4}`, 'counter:shared'].reverse());
    const returned = await Promise.all(keySets.map(keys => engine.transaction(async tx => {
      await tx.executeRaw("SELECT set_config('lock_timeout','10s',true)");
      const rows = await lockCounters(tx, keys);
      await tx.executeRaw('UPDATE persistence_counters SET outstanding_count=outstanding_count+1 WHERE key=ANY($1::text[])', [rows.map(row => row.key)]);
      return rows.map(row => row.key);
    })));
    for (const [i, keys] of returned.entries()) expect(keys).toEqual([...new Set(keySets[i]!)].sort());
    const counts = Object.fromEntries((await engine.executeRaw<{ key: string; n: number }>(
      'SELECT key,outstanding_count::int AS n FROM persistence_counters ORDER BY key')).map(row => [row.key, row.n]));
    const expected: Record<string, number> = {};
    for (const keys of keySets) for (const key of new Set(keys)) expected[key] = (expected[key] ?? 0) + 1;
    expect(counts).toEqual(expected);
  });

  test('a counter row already locked by another transaction is waited for, then returned current', async () => {
    await engine.transaction(tx => lockCounters(tx, ['counter:wait']));
    const holder = holdTransaction(engine, async tx => {
      await lockCounters(tx, ['counter:wait']);
      await tx.executeRaw("UPDATE persistence_counters SET outstanding_count=41 WHERE key='counter:wait'");
    });
    await holder.entered;
    const waiter = engine.transaction(tx => lockCounters(tx, ['counter:wait', 'brain']));
    expect(await settlesWithin(waiter)).toBe(false);
    holder.release();
    await holder.done;
    expect((await waiter).map(row => [row.key, Number(row.outstanding_count)])).toEqual([['brain', expect.any(Number)], ['counter:wait', 41]]);
  });
});
