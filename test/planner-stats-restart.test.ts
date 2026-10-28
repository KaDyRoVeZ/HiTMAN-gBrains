/**
 * F4b (spec 5.3 tests 4 and 6, O-CEO-17): planner-stats deltas are durable
 * across crashes and restarts. Real child processes on a persisted PGLite data
 * dir (test/helpers/planner-stats-child.ts). Serial: each case spawns bun
 * processes that open the same data dir one at a time.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHILD = join(import.meta.dir, 'helpers', 'planner-stats-child.ts');

function child(dataDir: string, ...args: string[]) {
  const proc = Bun.spawnSync(['bun', CHILD, dataDir, ...args], {
    env: { ...process.env, GBRAIN_HOME: mkdtempSync(join(tmpdir(), 'planner-home-')), GBRAIN_PGLITE_SNAPSHOT: '' },
    stdout: 'pipe', stderr: 'pipe',
  });
  return { exitCode: proc.exitCode, signal: proc.signalCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

function lastJson(stdout: string) {
  return JSON.parse(stdout.trim().split('\n').filter(l => l.startsWith('{')).at(-1)!);
}

describe('planner-stats durability (O-CEO-17)', () => {
  test('4. a crash right after commit keeps the committed modifications pending', () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'planner-crash-')), 'brain.pglite');
    const crashed = child(dataDir, 'insert-crash', '700');
    expect(crashed.stdout).toContain('COMMITTED');
    expect(crashed.signal).toBe('SIGKILL');

    const reopened = child(dataDir, 'first-read');
    expect(reopened.exitCode).toBe(0);
    const report = lastJson(reopened.stdout);
    expect(report.before).toMatchObject({ table: 'facts', pending: 700, stale: true });
  }, 120_000);

  test('6. five restarts of 150 facts each: the first get_health in a sixth process analyzes facts within the budget', () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'planner-restart-')), 'brain.pglite');
    for (let i = 0; i < 5; i++) {
      const run = child(dataDir, 'insert', '150');
      expect(run.exitCode).toBe(0);
    }

    const sixth = child(dataDir, 'first-read');
    expect(sixth.exitCode).toBe(0);
    const report = lastJson(sixth.stdout);
    expect(report.before).toMatchObject({ pending: 750, stale: true });
    expect(report.events).toContainEqual(expect.objectContaining({ table: 'facts', during_read: true }));
    expect(report.events.find((e: { table: string }) => e.table === 'facts').ms).toBeLessThan(2000);
    expect(report.after).toMatchObject({ pending: 0, stale: false, has_stats: true });
  }, 180_000);
});
