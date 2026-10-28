/**
 * Synthetic job-load fixture for the long-job lane reservation (#7242).
 *
 * Measures queue wait (claim time minus submit time, both stamped by the
 * database: `started_at - created_at`) for short jobs under a mixed load on
 * an in-memory PGLite brain with one 2-slot worker. The run is scaled down from
 * the shape that motivated the issue (50-minute maintenance passes starving
 * per-page jobs): 3 long jobs of 1500 ms and 40 short jobs of 30 ms, submitted
 * interleaved on a fixed schedule (a long job at 0, 350 and 700 ms; a short job
 * every 50 ms from 25 ms). It runs once with no reserved slot (before) and once
 * with one (after) and prints p50 / p95 / max for the short jobs.
 *
 * Usage: bun scripts/bench/minions-lane-load.ts [--json]
 * test/minions-lane-load.slow.test.ts runs the same fixture and asserts the
 * reservation cuts short-job p95 wait.
 */
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';

export interface LaneLoadOptions {
  longMs: number;
  shortMs: number;
  longAtMs: number[];
  shortCount: number;
  shortEveryMs: number;
  shortStartMs: number;
  concurrency: number;
}

export const DEFAULT_LANE_LOAD: LaneLoadOptions = {
  longMs: 1500,
  shortMs: 30,
  longAtMs: [0, 300, 600],
  shortCount: 30,
  shortEveryMs: 150,
  shortStartMs: 50,
  concurrency: 2,
};

export interface WaitSummary {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export interface LaneLoadResult {
  reservedSlots: number;
  short: WaitSummary;
  long: WaitSummary;
  wallMs: number;
}

const LONG = 'lane-fixture-long';
const SHORT = 'lane-fixture-short';

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
}

export function summarize(waits: number[]): WaitSummary {
  const sorted = [...waits].sort((a, b) => a - b);
  return { count: sorted.length, p50: percentile(sorted, 50), p95: percentile(sorted, 95), max: sorted.at(-1) ?? 0 };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
}

/** One run on a fresh in-memory brain. */
export async function runLaneLoad(reservedSlots: number, opts: LaneLoadOptions = DEFAULT_LANE_LOAD): Promise<LaneLoadResult> {
  const engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  try {
    const queue = new MinionQueue(engine);
    const worker = new MinionWorker(engine, {
      concurrency: opts.concurrency,
      pollInterval: 20,
      healthCheckInterval: 0,
      stalledInterval: 60_000,
      longJobNames: [LONG],
      shortJobReservedSlots: reservedSlots,
    });
    worker.register(LONG, async () => { await sleep(opts.longMs); });
    worker.register(SHORT, async () => { await sleep(opts.shortMs); });

    const schedule = [
      ...opts.longAtMs.map(at => ({ at, name: LONG })),
      ...Array.from({ length: opts.shortCount }, (_, i) => ({ at: opts.shortStartMs + i * opts.shortEveryMs, name: SHORT })),
    ].sort((a, b) => a.at - b.at);

    const t0 = performance.now();
    const running = worker.start();
    for (const item of schedule) {
      await sleep(item.at - (performance.now() - t0));
      await queue.add(item.name, {});
    }
    const total = schedule.length;
    while (true) {
      const [row] = await engine.executeRaw<{ done: number }>(`SELECT count(*)::int AS done FROM minion_jobs WHERE status = 'completed'`);
      if (Number(row?.done) >= total) break;
      await sleep(50);
    }
    const wallMs = Math.round(performance.now() - t0);
    worker.stop();
    await running;

    const rows = await engine.executeRaw<{ name: string; wait_ms: number }>(
      `SELECT name, (EXTRACT(EPOCH FROM (started_at - created_at)) * 1000)::float8 AS wait_ms FROM minion_jobs`,
    );
    const waits = (name: string) => rows.filter(r => r.name === name).map(r => Math.round(Number(r.wait_ms)));
    return { reservedSlots, short: summarize(waits(SHORT)), long: summarize(waits(LONG)), wallMs };
  } finally {
    await engine.disconnect();
  }
}

export async function runBeforeAfter(opts: LaneLoadOptions = DEFAULT_LANE_LOAD): Promise<{ before: LaneLoadResult; after: LaneLoadResult }> {
  const before = await runLaneLoad(0, opts);
  const after = await runLaneLoad(1, opts);
  return { before, after };
}

function line(label: string, r: LaneLoadResult): string {
  return `${label} (reserved ${r.reservedSlots}): short wait p50 ${r.short.p50} ms, p95 ${r.short.p95} ms, max ${r.short.max} ms; ` +
    `long wait max ${r.long.max} ms; wall ${r.wallMs} ms`;
}

if (import.meta.main) {
  const { before, after } = await runBeforeAfter();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ options: DEFAULT_LANE_LOAD, before, after }, null, 2));
  } else {
    console.log(line('before', before));
    console.log(line('after ', after));
  }
}
