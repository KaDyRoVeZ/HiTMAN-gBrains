/**
 * #7261: the drain-lease holder record (queue gbrain-drain-lease, written by a sync that holds the source's drain
 * lease) is an active row no worker claims, with attempts_started 0. The stall, timeout and wall-clock sweeps
 * matched it once its sync ran past two lock durations (or once its holder died), counted an attempt it never
 * started, and broke chk_attempts_order. The exception rolled back the whole sweep, so every other stalled job
 * stayed stalled, and the dream inline drain's housekeeping failed the synthesize phase after its children finished.
 * The sweeps now skip the beacon queue; the lease renews and deletes its own row.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { LEASE_BEACON_QUEUE, withDrainLease } from '../src/core/persistence/sync-lease.ts';
import { runSubagentsInline } from '../src/core/cycle/inline-drain.ts';
import type { SyncResult } from '../src/commands/sync.ts';

describe('#7261 the job sweeps never touch the drain-lease holder record', () => {
  let engine: PGLiteEngine;
  let queue: MinionQueue;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
    queue = new MinionQueue(engine);
  });
  afterAll(async () => { await engine.disconnect(); });

  const beacon = async () => (await engine.executeRaw<{ id: number; status: string; attempts_made: number }>(
    'SELECT id, status, attempts_made FROM minion_jobs WHERE queue = $1', [LEASE_BEACON_QUEUE]))[0];

  /** Runs `body` while a real sync drain lease on source-a holds its holder record. */
  const underLease = (body: () => Promise<void>) => withDrainLease(engine, 'source-a', { holder: { kind: 'cli' } }, async () => {
    await body();
    return { status: 'up_to_date' } as unknown as SyncResult;
  });

  test('a long-held lease: the wall-clock sweep leaves the record, and a stuck job in the same sweep still dies', async () => {
    const stuck = await queue.add('noop', {}, { queue: 'default' });
    await underLease(async () => {
      await engine.executeRaw(`UPDATE minion_jobs SET started_at = now() - interval '1 hour' WHERE queue = $1`, [LEASE_BEACON_QUEUE]);
      expect((await queue.claim('tok-7261', 600_000, 'default', ['noop']))?.id).toBe(stuck.id);
      await engine.executeRaw(`UPDATE minion_jobs SET started_at = now() - interval '1 hour' WHERE id = $1`, [stuck.id]);
      const killed = await queue.handleWallClockTimeouts(1000);
      expect(killed.map(j => j.id)).toEqual([stuck.id]);
      expect(await beacon()).toMatchObject({ status: 'active', attempts_made: 0 });
    });
    expect(await beacon()).toBeUndefined();
  });

  test("a dead holder's expired record: the stall sweep leaves it and still requeues a stalled job", async () => {
    const stalled = await queue.add('noop', {}, { queue: 'default', max_stalled: 3 });
    await underLease(async () => {
      await engine.executeRaw(`UPDATE minion_jobs SET lock_until = now() - interval '1 hour' WHERE queue = $1`, [LEASE_BEACON_QUEUE]);
      expect((await queue.claim('tok-7261b', 600_000, 'default', ['noop']))?.id).toBe(stalled.id);
      await engine.executeRaw(`UPDATE minion_jobs SET lock_until = now() - interval '1 hour' WHERE id = $1`, [stalled.id]);
      const { requeued, dead } = await queue.handleStalled(0);
      expect(requeued.map(j => j.id)).toEqual([stalled.id]);
      expect(dead).toEqual([]);
      expect(await queue.handleTimeouts()).toEqual([]);
      expect(await beacon()).toMatchObject({ status: 'active', attempts_made: 0 });
    });
  });

  test('the dream inline drain finishes its children while a long sync holds the lease', async () => {
    const child = await queue.add('subagent', { prompt: 'p' }, { queue: 'dream-inline-7261' }, { allowProtectedSubmit: true });
    await underLease(async () => {
      await engine.executeRaw(`UPDATE minion_jobs SET started_at = now() - interval '1 hour' WHERE queue = $1`, [LEASE_BEACON_QUEUE]);
      await runSubagentsInline(engine, queue, 'dream-inline-7261', undefined, async () => ({ ok: true }), 1000);
    });
    expect((await queue.getJob(child.id))!.status).toBe('completed');
  });
});
