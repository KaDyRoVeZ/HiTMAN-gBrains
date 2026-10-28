/**
 * Shrunk crash-robot failures, replayed as regression tests. Each fixture in
 * test/fixtures/crash-robot/ is a minimal sequence plus the seam where the
 * worker is SIGKILLed; it reproduced 3/3 before its fix. The replay runs the
 * real process-separated crash and recovery (scripts/persistence/robot-driver.ts)
 * and requires zero reference-model violations.
 *
 * Protects: every safety-class bug the crash robot found stays fixed.
 * Fails when: the fix named in a fixture's description is reverted.
 * Seams: the gate's fault hook (src/core/persistence/fault-points.ts), installed only in the spawned workers.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRobotPhase, type RobotRun } from '../scripts/persistence/robot-driver.ts';
import { spawnWorker } from '../scripts/persistence/validate.ts';

const dir = join(import.meta.dir, 'fixtures', 'crash-robot');
for (const file of readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
  const fixture = JSON.parse(readFileSync(join(dir, file), 'utf8')) as { engine: 'pglite' | 'postgres'; failing_runs: RobotRun[] };
  test(`${fixture.engine}: ${file.replace(/\.json$/, '')} stays fixed`, async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'gbrain-crash-robot-regression-'));
    const home = join(scratch, 'home'); mkdirSync(home);
    const children: ReturnType<typeof spawnWorker>[] = [];
    try {
      const result = await runRobotPhase({ engine: fixture.engine, seed: 0, seconds: 0, scratch, home, databases: [],
        spawn: spawnWorker, track: child => { children.push(child); }, replay: fixture.failing_runs, log: () => {} });
      expect(result.crashed_runs).toBe(fixture.failing_runs.filter(run => run.fault).length);
      expect(result.violations).toEqual([]);
    } finally {
      await Promise.allSettled(children.map(child => child.kill()));
      rmSync(scratch, { recursive: true, force: true });
    }
  }, 300_000);
}
