/**
 * Disk-PGLite reconciliation SIGKILL cases, shared by the
 * test/reconcile-crash-{unactivated,activated}-{1,2}.slow.test.ts files: every
 * crash boundary before and after activation, split four ways so a CI queue
 * can run them side by side (each case is an independent worker process).
 */
import { expect, test } from 'bun:test';
import { CRASH_BOUNDARIES, runReconcileCrashCase } from '../fixtures/reconcile-crash-worker.ts';

/** The half (1 or 2) of CRASH_BOUNDARIES a file covers. */
export function crashBoundaries(half: 1 | 2): (typeof CRASH_BOUNDARIES)[number][] {
  const mid = Math.ceil(CRASH_BOUNDARIES.length / 2);
  return half === 1 ? CRASH_BOUNDARIES.slice(0, mid) : CRASH_BOUNDARIES.slice(mid);
}

export function reconcileCrashTests(enabled: boolean, boundaries: (typeof CRASH_BOUNDARIES)[number][]): void {
  for (const boundary of boundaries) {
    test(`disk PGLite reconciliation survives SIGKILL/${boundary}, activation=${enabled}`, async () => {
      const result = await runReconcileCrashCase({ kind: 'pglite', boundary, enabled });
      expect(result).toMatchObject({ status: 'passed', boundary, enabled, killed_signal: 'SIGKILL',
        committed_requests: 1, added_versions: 1, normal_apply_replay: true, originals_retained: true,
        receipt_unchanged: true, recovery_cleared: true, staging_cleaned: true, topology_unchanged: true, counters_conserved: true });
      if (boundary === 'staging_flushed') expect(result.flushed_before_rename_verified).toBe(true);
      if (boundary === 'after_response') expect(result.response_read_before_kill).toBe(true);
    }, 180_000);
  }
}
