/**
 * `jobs stats --queue <dream-inline-*>` — ABANDONED PRIVATE QUEUE gating
 * (src/commands/jobs.ts stats case). The line is gated on the SAME classifier
 * recovery uses (classifyPrivateQueueForRecovery), so the scream and the
 * advertised repair cannot drift:
 *
 *   - orphan  (terminal owner, aged, expired lease) → ABANDONED + the
 *     auto-recovery remediation (next worker spawn / dream-cycle start);
 *   - unowned (legacy, no owner metadata, aged)     → ABANDONED + retriage;
 *   - live    (future lease / fresh touch)          → NEITHER the ABANDONED
 *     line NOR the WEDGED warning (a private queue is never "wedged" — the
 *     supervisor-restart advice would be a dead end).
 *
 * Serial: captures console.log around runJobs (process-global stdout seam),
 * mirroring test/jobs-stats-divergence.serial.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runJobs } from '../src/commands/jobs.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw(`DELETE FROM minion_jobs`, []);
});

async function captureStats(args: string[]): Promise<string> {
  const origLog = console.log;
  let out = '';
  console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
  try {
    await runJobs(engine, args);
  } finally {
    console.log = origLog;
  }
  return out;
}

describe('jobs stats — ABANDONED PRIVATE QUEUE classifier gating', () => {
  test('orphan (terminal owner, aged, expired lease) screams ABANDONED with the auto-recovery remediation', async () => {
    const q = 'dream-inline-1700000000000-dead0001';
    await engine.executeRaw(
      `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, created_at)
       VALUES ('{"version":1,"kind":"application"}'::jsonb, 'dream-cycle', 'default', 'completed', '{}'::jsonb, now() - interval '3 hours')`,
      [],
    );
    const owner = await engine.executeRaw<{ id: number }>(`SELECT max(id)::int AS id FROM minion_jobs`, []);
    await engine.executeRaw(
      `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, created_at, updated_at,
                                private_queue_owner_job_id, private_queue_owner_token, private_queue_lease_until)
       SELECT '{"version":1,"kind":"application"}'::jsonb, 'subagent', $1, 'waiting', '{}'::jsonb, now() - interval '2 hours', now() - interval '2 hours',
              $2, 'tok', now() - interval '1 hour'
         FROM generate_series(1, 2)`,
      [q, owner[0].id],
    );
    const out = await captureStats(['stats', '--queue', q]);
    expect(out).toContain(`ABANDONED PRIVATE QUEUE '${q}'`);
    expect(out).toContain('Auto-recovery cancels it at the next worker spawn or dream-cycle start');
    expect(out).not.toContain('WEDGED QUEUE');
  });

  test('legacy unowned (no owner metadata, aged) screams ABANDONED with the retriage remediation', async () => {
    const q = 'dream-inline-1700000000000-dead0002';
    await engine.executeRaw(
      `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, created_at, updated_at)
       VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', $1, 'waiting', '{}'::jsonb, now() - interval '2 hours', now() - interval '2 hours')`,
      [q],
    );
    const out = await captureStats(['stats', '--queue', q]);
    expect(out).toContain(`ABANDONED PRIVATE QUEUE '${q}'`);
    expect(out).toContain('retriage');
    expect(out).not.toContain('WEDGED QUEUE');
  });

  test('live (future lease) renders NEITHER the ABANDONED line NOR the wedged warning', async () => {
    const q = 'dream-inline-1700000000000-live0003';
    // Aged enough to be a candidate, but the future lease classifies live —
    // a healthy mid-drain queue must not scream.
    await engine.executeRaw(
      `INSERT INTO minion_jobs (submission_authority, name, queue, status, data, created_at, updated_at, private_queue_lease_until)
       VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', $1, 'waiting', '{}'::jsonb, now() - interval '2 hours', now() - interval '2 hours',
               now() + interval '30 minutes')`,
      [q],
    );
    const out = await captureStats(['stats', '--queue', q]);
    expect(out).toContain('Queue health'); // stats really rendered (guards the not.toContain below)
    expect(out).not.toContain('ABANDONED');
    expect(out).not.toContain('WEDGED QUEUE');
  });
});

describe('jobs stats — per-queue lines fold dream-inline-* queues (#7241)', () => {
  async function seed(): Promise<void> {
    await engine.executeRaw(
      `INSERT INTO minion_jobs (submission_authority, name, queue, status, data)
       SELECT '{"version":1,"kind":"application"}'::jsonb, 'sync', 'default', s, '{}'::jsonb FROM unnest(ARRAY['waiting','completed','completed']) AS s`,
      [],
    );
    for (const [q, status] of [['dream-inline-1700000000000-aaaa0001', 'completed'], ['dream-inline-1700000000001-aaaa0002', 'completed'],
      ['dream-inline-1700000000002-aaaa0003', 'dead']] as const) {
      await engine.executeRaw(
        `INSERT INTO minion_jobs (submission_authority, name, queue, status, data)
         VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', $1, $2, '{}'::jsonb)`,
        [q, status],
      );
    }
  }

  test('getStats reports one dream-inline row for every per-run queue, beside the named queues', async () => {
    await seed();
    const { MinionQueue } = await import('../src/core/minions/queue.ts');
    const stats = await new MinionQueue(engine).getStats();
    expect(stats.by_queue).toEqual([
      { queue: 'default', queues: 1, waiting_now: 1, active_now: 0, total: 3, completed: 2, failed: 0, dead: 0 },
      { queue: 'dream-inline', queues: 3, waiting_now: 0, active_now: 0, total: 3, completed: 2, failed: 0, dead: 1 },
    ]);
  });

  test('the default output prints a line per queue family; --json carries by_queue; --queue <dream-inline-x> still scopes one queue', async () => {
    await seed();
    const out = await captureStats(['stats']);
    expect(out).toMatch(/dream-inline \(3 queues\)\s+0 waiting, 0 active, 3 total, 2 done, 0 failed, 1 dead/);
    expect(out).toMatch(/default\s+1 waiting, 0 active, 3 total, 2 done, 0 failed, 0 dead/);
    const json = JSON.parse(await captureStats(['stats', '--json']));
    expect(json.by_queue.map((r: { queue: string }) => r.queue)).toEqual(['default', 'dream-inline']);
    expect(json.queue).toBe('default');
    const one = JSON.parse(await captureStats(['stats', '--json', '--queue', 'dream-inline-1700000000002-aaaa0003']));
    expect(one.wedge.queue).toBe('dream-inline-1700000000002-aaaa0003');
  });
});

