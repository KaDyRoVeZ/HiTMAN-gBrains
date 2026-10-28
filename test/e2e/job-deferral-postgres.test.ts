/**
 * JobDeferredError on Postgres (and, when DATABASE_URL points at a
 * transaction-mode pooler, through PgBouncer): the worker returns a deferred
 * job to delayed via MinionQueue.deferJob with no attempt counted and no
 * stacktrace entry, and a stale lock token defers nothing.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { JobDeferredError } from '../../src/core/minions/errors.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;

describeE2E('E2E: job deferral (Lane D)', () => {
  beforeAll(async () => { await setupDB(); });
  afterAll(async () => { await teardownDB(); });

  test('a deferred job waits with no attempt counted', async () => {
    const queue = new MinionQueue(getEngine());
    const job = await queue.add('defer-e2e', {}, { max_attempts: 2 });
    const worker = new MinionWorker(getEngine(), { pollInterval: 50 });
    worker.register('defer-e2e', async () => { throw new JobDeferredError('no_key', 'waiting for a key', 60_000); });
    const running = worker.start();
    for (let i = 0; i < 200; i++) {
      if ((await queue.getJob(job.id))?.status === 'delayed') break;
      await new Promise(r => setTimeout(r, 50));
    }
    worker.stop();
    await running;
    const row = (await queue.getJob(job.id))!;
    expect(row).toMatchObject({ status: 'delayed', attempts_made: 0, error_text: 'deferred (no_key): waiting for a key' });
    expect(row.stacktrace ?? []).toEqual([]);
    expect(row.delay_until!.getTime()).toBeGreaterThan(Date.now() + 30_000);
  });

  test('deferJob is token-fenced', async () => {
    const queue = new MinionQueue(getEngine());
    const job = await queue.add('defer-e2e-fence', {});
    const claimed = await queue.claim('token-a', 30_000, 'default', ['defer-e2e-fence']);
    expect(claimed?.id).toBe(job.id);
    expect(await queue.deferJob(job.id, 'token-b', 'deferred (x): y', 0)).toBeNull();
    expect((await queue.deferJob(job.id, 'token-a', 'deferred (x): y', 0))?.status).toBe('delayed');
  });
});
