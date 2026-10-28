/**
 * #7263: the background doctor-refresh job must not hold a one-slot worker. It queues behind sync, the autopilot
 * cycles, global maintenance and loops extract (a numerically higher priority), stops starting checks at an overall
 * budget well under its hourly slot and still completes, recording what it measured, and an operator can turn it off.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { DEFAULT_LONG_JOB_NAMES } from '../src/core/minions/lanes.ts';
import { LAST_KNOWN_OP, REFRESH_BUDGET_MS, REFRESH_JOB, queueRefresh, runDoctorRefresh } from '../src/commands/doctor/last-known.ts';
import { waitFor } from './helpers/wait-for.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM op_checkpoints WHERE op = $1', [LAST_KNOWN_OP]);
  await engine.executeRaw("DELETE FROM config WHERE key = 'doctor.background_refresh'");
});

async function claimOrder(): Promise<number[]> {
  const rows = await engine.executeRaw<{ id: number }>('SELECT id FROM minion_jobs WHERE started_at IS NOT NULL ORDER BY started_at, id');
  return rows.map(r => Number(r.id));
}

/** An engine whose every SQL statement takes 100 ms, so each doctor entry is slow and the full refresh takes far longer than its budget. */
function slowEngine(inner: PGLiteEngine): PGLiteEngine {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === 'executeRaw' || prop === 'executeRawDirect') {
        return async (...args: unknown[]) => { await new Promise(r => setTimeout(r, 100)); return value.apply(target, args); };
      }
      return value.bind(target);
    },
  });
}

describe('doctor-refresh on a one-slot worker (#7263)', () => {
  test('a sync queued after a refresh is claimed first, and the refresh runs once the slot is free', async () => {
    const refresh = await queueRefresh(engine);
    expect(refresh).not.toBeNull();
    const sync = await queue.add('sync', { sourceId: 'source-a' });
    const worker = new MinionWorker(engine, { concurrency: 1, pollInterval: 20, healthCheckInterval: 0, stalledInterval: 60_000 });
    worker.register(REFRESH_JOB, async () => ({ ok: true }));
    worker.register('sync', async () => ({ ok: true }));
    const running = worker.start();
    try {
      await waitFor(async () => (await queue.getJob(refresh!.id))?.status === 'completed', { timeoutMs: 10_000, label: 'refresh completed' });
    } finally {
      worker.stop();
      await running;
    }
    expect(await claimOrder()).toEqual([sync.id, refresh!.id]);
  }, 30_000);

  test('the refresh queues behind sync, the autopilot cycles, global maintenance and loops extract, with a timeout over its budget', async () => {
    const job = (await queue.getJob((await queueRefresh(engine))!.id))!;
    expect(job.priority).toBeGreaterThan(5);
    expect(job.timeout_ms).toBeGreaterThan(REFRESH_BUDGET_MS);
    expect(job.timeout_ms).toBeLessThanOrEqual(30 * 60_000);
    expect(REFRESH_BUDGET_MS).toBeLessThanOrEqual(10 * 60_000);
  });

  test('a two-slot worker treats the refresh as a long job', () => {
    expect(DEFAULT_LONG_JOB_NAMES).toContain(REFRESH_JOB);
  });

  test('doctor.background_refresh false queues nothing', async () => {
    await engine.setConfig('doctor.background_refresh', 'false');
    expect(await queueRefresh(engine)).toBeNull();
    expect(await engine.executeRaw('SELECT id FROM minion_jobs WHERE name = $1', [REFRESH_JOB])).toHaveLength(0);
  });
});

describe('doctor-refresh overall budget (#7263)', () => {
  test('a refresh whose entries are slow stops at its budget, records what it measured and completes', async () => {
    const budgetMs = 3_000;
    const job = await queue.add(REFRESH_JOB, {}, { queue: 'default', max_attempts: 1 });
    const worker = new MinionWorker(engine, { concurrency: 1, pollInterval: 20, healthCheckInterval: 0, stalledInterval: 60_000 });
    worker.register(REFRESH_JOB, async () => runDoctorRefresh(slowEngine(engine), budgetMs));
    const running = worker.start();
    try {
      await waitFor(async () => ['completed', 'failed', 'dead'].includes((await queue.getJob(job.id))?.status ?? ''), { timeoutMs: 30_000, label: 'refresh settled' });
    } finally {
      worker.stop();
      await running;
    }
    const done = (await queue.getJob(job.id))!;
    expect(done.status).toBe('completed');
    const result = done.result as { recorded: number; unfinished: string[]; elapsed_ms: number };
    expect(result.unfinished.length).toBeGreaterThan(0);
    expect(result.recorded).toBeGreaterThan(0);
    expect(result.elapsed_ms).toBeLessThan(budgetMs + 5_000);
    const [{ n }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM op_checkpoints WHERE op = $1', [LAST_KNOWN_OP]);
    expect(n).toBeGreaterThan(0);
  }, 60_000);
});
