/**
 * Runs the synthetic job-load fixture (scripts/bench/minions-lane-load.ts)
 * before and after the long-job lane reservation (#7242) and asserts the
 * reservation cuts short-job queue wait. About 10 s of real time, so it lives
 * in the slow tier.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_LANE_LOAD, percentile, runBeforeAfter, summarize } from '../scripts/bench/minions-lane-load.ts';

describe('lane-load fixture helpers', () => {
  test('nearest-rank percentiles', () => {
    expect(percentile([], 95)).toBe(0);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(summarize([30, 10, 20])).toEqual({ count: 3, p50: 20, p95: 30, max: 30 });
  });
});

describe('short-job queue wait under mixed load (#7242)', () => {
  test('one reserved slot cuts short-job p95 wait on a 2-slot worker', async () => {
    const { before, after } = await runBeforeAfter();
    console.log(`[lane-load] before p50=${before.short.p50} p95=${before.short.p95} max=${before.short.max} ms; after p50=${after.short.p50} p95=${after.short.p95} max=${after.short.max} ms`);
    expect(before.short.count).toBe(DEFAULT_LANE_LOAD.shortCount);
    expect(after.short.count).toBe(DEFAULT_LANE_LOAD.shortCount);
    expect(after.long.count).toBe(DEFAULT_LANE_LOAD.longAtMs.length);
    // Before: two long jobs hold both slots for most of a long run, so short jobs wait behind them.
    expect(before.short.p95).toBeGreaterThanOrEqual(DEFAULT_LANE_LOAD.longMs / 2);
    expect(after.short.p95 * 4).toBeLessThan(before.short.p95);
  }, 60_000);
});
