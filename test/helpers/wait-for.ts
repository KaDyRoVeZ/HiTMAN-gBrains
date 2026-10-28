/**
 * Deadline-bounded polling for tests that await an async condition (a file
 * appearing, a child writing a row, a heartbeat firing). Replaces bare
 * `await sleep(N)` guesses — the poll returns as soon as the condition holds
 * and fails loudly (label + elapsed) instead of flaking on slow machines.
 *
 * The predicate is checked at least once even with timeoutMs <= 0.
 */
export interface WaitForOpts {
  /** Deadline. Default 5000ms. Scaled by GBRAIN_TEST_WAIT_MULTIPLIER (see testWaitMs). */
  timeoutMs?: number;
  /** Poll interval. Default 10ms. */
  intervalMs?: number;
  /** Names the condition in the timeout error. */
  label?: string;
}

/**
 * GBRAIN_TEST_WAIT_MULTIPLIER (default 1) scales every test deadline for
 * instrumented lanes: scripts/lib/test-env.sh sets 2 when COVERAGE_DIR is
 * set, because coverage slows the code under test while the deadlines stay
 * wall-clock. Accepted range 1..4; anything else fails the test loudly.
 */
export function testWaitMultiplier(): number {
  const raw = process.env.GBRAIN_TEST_WAIT_MULTIPLIER;
  if (raw === undefined || raw === '') return 1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1 || value > 4) {
    throw new Error(
      `GBRAIN_TEST_WAIT_MULTIPLIER=${JSON.stringify(raw)} is not a number from 1 to 4.\n`
      + 'Why: it scales test wait deadlines (test/helpers/wait-for.ts); a bad value would make every deadline meaningless.\n'
      + 'Fix: unset GBRAIN_TEST_WAIT_MULTIPLIER, or set it to a value from 1 to 4 (coverage lanes use 2).\n'
      + 'Docs: docs/TESTING.md#speed--environment-helpers-testhelpers',
    );
  }
  return value;
}

/**
 * Bun's per-test timeout in every runner is 60s; a scaled deadline stays at
 * or below this ceiling (or its unscaled base, if larger) so a slow condition
 * fails as a labeled waitFor error, never as an anonymous bun timeout.
 */
const SCALED_DEADLINE_CEILING_MS = 50_000;

/** `ms` scaled by GBRAIN_TEST_WAIT_MULTIPLIER, capped below bun's per-test timeout. */
export function testWaitMs(ms: number): number {
  const multiplier = testWaitMultiplier();
  if (multiplier === 1) return ms;
  return Math.max(ms, Math.min(Math.round(ms * multiplier), SCALED_DEADLINE_CEILING_MS));
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: WaitForOpts = {},
): Promise<void> {
  const baseTimeoutMs = opts.timeoutMs ?? 5000;
  const timeoutMs = testWaitMs(baseTimeoutMs);
  const intervalMs = opts.intervalMs ?? 10;
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    const elapsed = Date.now() - start;
    if (elapsed >= timeoutMs) {
      const label = opts.label ? `${opts.label}: ` : '';
      const scaled = timeoutMs === baseTimeoutMs ? '' : ` scaled to ${timeoutMs}ms by GBRAIN_TEST_WAIT_MULTIPLIER`;
      throw new Error(
        `waitFor: ${label}condition still false after ${elapsed}ms (timeout ${baseTimeoutMs}ms${scaled})`,
      );
    }
    // Clamp the final sleep to the remaining deadline so a coarse interval
    // can't overshoot the timeout by a full interval. (A predicate that HANGS
    // is out of scope by design — bun's per-test --timeout is that backstop.)
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(intervalMs, timeoutMs - elapsed)));
  }
}

/**
 * Poll `fn` until it yields a non-null, non-undefined value; return it.
 * Same deadline/label semantics as waitFor.
 */
export async function waitForValue<T>(
  fn: () => T | undefined | null | Promise<T | undefined | null>,
  opts: WaitForOpts = {},
): Promise<T> {
  let value: T | undefined | null;
  await waitFor(async () => {
    value = await fn();
    return value !== undefined && value !== null;
  }, opts);
  return value as T;
}
