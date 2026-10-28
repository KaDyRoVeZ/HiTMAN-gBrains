import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { waitFor } from './helpers/wait-for.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

async function submitInOrder(names: string[]): Promise<number[]> {
  const ids: number[] = [];
  for (const [i, name] of names.entries()) {
    const job = await queue.add(name, { i });
    await engine.executeRaw(`UPDATE minion_jobs SET created_at = now() - make_interval(secs => $2) WHERE id = $1`, [job.id, 100 - i]);
    ids.push(job.id);
  }
  return ids;
}

async function statusOf(id: number): Promise<string | undefined> {
  return (await queue.getJob(id))?.status;
}

/** Ids in the order the queue claimed them (started_at is stamped by the claim UPDATE; handler start order can differ). */
async function claimOrder(): Promise<number[]> {
  const rows = await engine.executeRaw<{ id: number }>('SELECT id FROM minion_jobs WHERE started_at IS NOT NULL ORDER BY started_at, id');
  return rows.map(r => Number(r.id));
}

/** Long handler blocks on a shared gate; short handler returns at once. */
async function runMixed(opts: { concurrency: number; shortJobReservedSlots: number }) {
  const [long1, long2, short] = await submitInOrder(['fixture-long', 'fixture-long', 'fixture-short']);
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const started: number[] = [];
  const worker = new MinionWorker(engine, {
    concurrency: opts.concurrency,
    pollInterval: 20,
    healthCheckInterval: 0,
    stalledInterval: 60_000,
    longJobNames: ['fixture-long'],
    shortJobReservedSlots: opts.shortJobReservedSlots,
  });
  worker.register('fixture-long', async (job) => { started.push(job.id); await gate; });
  worker.register('fixture-short', async (job) => { started.push(job.id); });
  const running = worker.start();
  return { long1, long2, short, started, release, worker, running };
}

describe('claim-time lane reservation for long jobs (#7242)', () => {
  test('a 2-slot worker running one long job claims the short job, not the second long job ahead of it', async () => {
    const run = await runMixed({ concurrency: 2, shortJobReservedSlots: 1 });
    try {
      await waitFor(async () => (await statusOf(run.short)) === 'completed', { timeoutMs: 10_000, label: 'short job completed' });
      expect(await claimOrder()).toEqual([run.long1, run.short]);
      // Several poll ticks with a free slot: the second long job must stay waiting.
      await new Promise(r => setTimeout(r, 300));
      expect(await statusOf(run.long2)).toBe('waiting');
      expect(await statusOf(run.long1)).toBe('active');
    } finally {
      run.release();
      await waitFor(async () => (await statusOf(run.long2)) === 'completed', { timeoutMs: 10_000, label: 'second long job ran after the first' });
      run.worker.stop();
      await run.running;
    }
    expect(await claimOrder()).toEqual([run.long1, run.short, run.long2]);
  }, 30_000);

  test('reserved slots 0 keeps the old FIFO claim: the second long job takes the second slot', async () => {
    const run = await runMixed({ concurrency: 2, shortJobReservedSlots: 0 });
    try {
      await waitFor(() => run.started.length >= 2, { timeoutMs: 10_000, label: 'two jobs claimed' });
      expect(await claimOrder()).toEqual([run.long1, run.long2]);
      expect(await statusOf(run.short)).toBe('waiting');
    } finally {
      run.release();
      await waitFor(async () => (await statusOf(run.short)) === 'completed', { timeoutMs: 10_000, label: 'short job completed' });
      run.worker.stop();
      await run.running;
    }
  }, 30_000);

  test('concurrency 1 is unaffected: the long job at the head of the queue is claimed', async () => {
    const run = await runMixed({ concurrency: 1, shortJobReservedSlots: 1 });
    try {
      await waitFor(() => run.started.length >= 1, { timeoutMs: 10_000, label: 'first job claimed' });
      expect(run.started[0]).toBe(run.long1);
      run.release();
      await waitFor(() => run.started.length >= 2, { timeoutMs: 10_000, label: 'second job claimed' });
      expect(run.started[1]).toBe(run.long2);
    } finally {
      run.release();
      await waitFor(async () => (await statusOf(run.short)) === 'completed', { timeoutMs: 10_000, label: 'short job completed' });
      run.worker.stop();
      await run.running;
    }
  }, 30_000);
});

describe('MinionQueue.claim excludeNames', () => {
  test('skips excluded names and claims the next eligible job in priority order', async () => {
    const [long1, short] = await submitInOrder(['fixture-long', 'fixture-short']);
    const claimed = await queue.claim('tok-exclude', 30_000, 'default', ['fixture-long', 'fixture-short'], { excludeNames: ['fixture-long'] });
    expect(claimed?.id).toBe(short);
    expect(await statusOf(long1)).toBe('waiting');
  });

  test('returns null when every waiting job is excluded, and an empty list excludes nothing', async () => {
    const [long1] = await submitInOrder(['fixture-long']);
    expect(await queue.claim('tok-none', 30_000, 'default', ['fixture-long'], { excludeNames: ['fixture-long'] })).toBeNull();
    expect((await queue.claim('tok-empty', 30_000, 'default', ['fixture-long'], { excludeNames: [] }))?.id).toBe(long1);
  });

  test('composes with excludeWatchdogSuspects', async () => {
    const [, short] = await submitInOrder(['fixture-long', 'fixture-short']);
    const claimed = await queue.claim('tok-both', 30_000, 'default', ['fixture-long', 'fixture-short'], { excludeWatchdogSuspects: true, excludeNames: ['fixture-long'] });
    expect(claimed?.id).toBe(short);
  });
});
