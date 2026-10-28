/**
 * Shared by the graduation-crash-*.test.ts suites: one crash-custody suite
 * (PGLite -> Postgres 16) split into files so a CI queue can run them side by
 * side. Every file is its own process with its own scratch root and fixture
 * cache; together they kill the real CLI at every run boundary
 * (graduation-crash-run-N) and every rollback substep
 * (graduation-crash-rollback-N). What each kill must leave behind is
 * documented in test/e2e/graduation-crash-run-1.test.ts.
 */
import { describe, expect } from 'bun:test';
import { rmSync } from 'node:fs';
import { GRADUATION_RUN_BOUNDARIES } from '../../src/core/persistence/engine-graduation.types.ts';
import { DATABASE_URL, gbrain, graduationTest, planHashOf, readEvents, startGbrain, stateOf, TARGET_ENV, waitForEvent } from './graduation-e2e.ts';
import {
  authority, configuredEngine, expectAtMostOneWriter, expectGraduated, legacyCase, manifestState, planAndRun, scratchRoot,
  targetFenceTriggers, withSource, type Case,
} from './graduation-scenarios.ts';

const cases: Case[] = [];
/** afterAll hook for every crash file: close each case's target and remove the scratch root. */
export async function closeCases(): Promise<void> {
  for (const c of cases) await c.target.close().catch(() => {});
  rmSync(scratchRoot, { recursive: true, force: true });
}

export async function fresh(name: string): Promise<Case> {
  const c = await legacyCase(name);
  cases.push(c);
  return c;
}

/** Start the confirmed run paused at `pause`, wait for it, SIGKILL it. */
export async function killAt(c: Case, pause: string, extra: string[] = []): Promise<void> {
  const { argv, env } = await planAndRun(c, { extra });
  const child = startGbrain(argv, { home: c.fx.home, env, hooks: { events: c.events, pause: [pause] }, timeoutMs: 600_000 });
  await waitForEvent(c.events, e => e.event === 'paused', child);
  child.kill('SIGKILL');
  const result = await child.exited;
  expect(result.signal).toBe('SIGKILL');
}

/** Graduate to completion with no kill. */
export async function graduate(c: Case): Promise<void> {
  const { argv, env } = await planAndRun(c);
  const run = await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 });
  expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
}

/** Start the rollback as an agent would (confirming with the hash if asked), paused at `boundary`, then SIGKILL it. */
export async function killRollbackAt(c: Case, boundary: string): Promise<void> {
  const hooks = { events: c.events, pause: [boundary] };
  let child = startGbrain(['migrate', '--rollback-to-source', '--json'], { home: c.fx.home, hooks });
  const paused = await waitForEvent(c.events, e => e.event === 'paused', child).then(() => true, () => false);
  if (!paused) {
    const first = await child.exited;
    expect(first.code).toBe(3);
    child = startGbrain(['migrate', '--rollback-to-source', '--yes', '--expect', String(planHashOf(first.json)), '--json'], { home: c.fx.home, hooks });
    await waitForEvent(c.events, e => e.event === 'paused' && e.boundary === boundary, child);
  }
  child.kill('SIGKILL');
  await child.exited;
}

/** Every run boundary, with the copy boundaries pinned to a multi-batch table (pages at --batch-size 2). */
export const RUN_KILLS: { pause: string; label: string }[] = GRADUATION_RUN_BOUNDARIES.map(b =>
  b === 'batch_copied' ? { pause: 'batch_copied@pages', label: 'mid-table (first committed batch of pages)' }
  : b === 'table_copied' ? { pause: 'table_copied@pages', label: 'table boundary (pages committed)' }
  : { pause: b, label: b });

/** SIGKILL at each of `kills` (a slice of RUN_KILLS), then a clean-process resume. */
export function runKillSuite(kills: typeof RUN_KILLS, more: () => void = () => {}): void {
  describe.skipIf(!DATABASE_URL)('graduation: SIGKILL at every custody boundary', () => {
    for (const { pause, label } of kills) {
      graduationTest(`kill at ${label}: at most one writer, status read-only, clean-process resume graduates`, async () => {
        const c = await fresh(`kill-${pause.replace(/[@]/g, '-')}`);
        await killAt(c, pause, ['--batch-size', '2']);
        expect(readEvents(c.events).filter(e => e.event === 'boundary').at(-1)?.boundary).toBe(pause.split('@')[0]);
        await expectAtMostOneWriter(c, `after kill at ${pause}`);

        const status = await gbrain(['migrate', '--status', '--json'], { home: c.fx.home });
        expect(status.code).toBe(0);
        // `graduated` is announced after its own durable write, so a kill there already reads graduated.
        if (pause !== 'graduated') expect(stateOf(status.json)).not.toBe('graduated');

        // No target URL in the environment: resume reads the 0600 manifest's recorded identities.
        const resumed = await gbrain(['migrate', '--resume', '--json'], { home: c.fx.home, env: { [TARGET_ENV]: undefined }, timeoutMs: 900_000 });
        expect({ code: resumed.code, stderr: resumed.code === 0 ? '' : resumed.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
        await expectGraduated(c, `kill at ${pause}`);
      }, 900_000);
    }
    more();
  });
}

/** SIGKILL at each of `boundaries` (a slice of GRADUATION_ROLLBACK_BOUNDARIES), then reconciliation. */
export function rollbackKillSuite(boundaries: readonly string[], more: () => void = () => {}): void {
  describe.skipIf(!DATABASE_URL)('graduation: SIGKILL at every rollback substep', () => {
    for (const boundary of boundaries) {
      graduationTest(`kill at ${boundary}: reconciliation ${boundary === 'rollback_fenced' ? 'restores target authority' : 'rolls forward to the source'}`, async () => {
        const c = await fresh(`rollback-${boundary}`);
        await graduate(c);
        await killRollbackAt(c, boundary);
        await expectAtMostOneWriter(c, `after kill at ${boundary}`);
        const status = await gbrain(['migrate', '--status', '--json'], { home: c.fx.home });
        expect(status.code).toBe(0);

        const resumed = await gbrain(['migrate', '--resume', '--json'], { home: c.fx.home, timeoutMs: 600_000 });
        expect({ code: resumed.code, stderr: resumed.code === 0 ? '' : resumed.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
        const a = await authority(c);
        if (boundary === 'rollback_fenced') {
          // Not yet approved: the live brain stays on the target.
          expect({ source: a.source, target: a.target }).toEqual({ source: false, target: true });
          expect(configuredEngine(c.fx).engine).toBe('postgres');
          const put = await gbrain(['put', 'notes/after-fenced-crash', '--source', 'default'], { home: c.fx.home, stdin: 'still live\n' });
          expect(put.code).toBe(0);
        } else {
          // Approved: never back to target authority; the source is live again.
          expect({ source: a.source, target: a.target }).toEqual({ source: true, target: false });
          expect(configuredEngine(c.fx).engine).toBe('pglite');
          expect(await targetFenceTriggers(c.target.url)).toBeGreaterThan(0);
          expect(manifestState(c.fx)).toBe('rolled_back');
          const put = await gbrain(['put', 'notes/after-rollback', '--source', 'default'], { home: c.fx.home, stdin: 'back on pglite\n' });
          expect(put.code).toBe(0);
          await withSource(c.fx, async source => {
            const [row] = await source.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE slug IN ('notes/queued-request','notes/after-rollback')`);
            expect(Number(row.n)).toBe(2);
          });
        }
      }, 900_000);
    }
    more();
  });
}
