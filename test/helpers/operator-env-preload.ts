/**
 * Pre-test setup: drop the operator's ambient agent/workspace context so the
 * unit suite's result depends on the code under test, not on whoever's shell
 * started it.
 *
 * scripts/run-e2e.sh already performs this scrub for the E2E lane (its
 * "Hermetic env scrub" block); the unit lane never got the same treatment.
 * Measured on one operator machine (#4023), ambient operator context alone
 * produced failures with no defect in the product: a stray GBRAIN_SOURCE
 * short-circuits source resolution at tier `env` before the tier under test
 * (8 failures across source-resolver-with-tier / source-resolver-silent-
 * fallback, 1 in extract-fs-source-id), and GBRAIN_CYCLE_FRESHNESS_WARN_HOURS
 * moves the very threshold doctor-cycle-freshness asserts. Provider
 * *_API_KEYs — the other ambient-failure class #4023 measured — are handled
 * by provider-keys-preload.ts; this preload deliberately leaves them alone.
 *
 * A preload rather than a runner-script scrub so a direct
 * `bun test test/foo.test.ts` — how anyone iterates on a single file — is
 * covered too. For the wrapper lanes the scrub is idempotent: run-e2e.sh
 * already unsets these prefixes and re-exports its own keeps at its own
 * subprocess boundary. This runs once, before any test file loads, so it only
 * removes ambient shell state — vars a test sets itself are never touched.
 *
 * CONDUCTOR_* / MCP_* / OPENCLAW_* are operator/agent workspace context with
 * no test-infrastructure tenants: stripped wholesale. GBRAIN_* is shared
 * between operator config overrides (must be stripped) and this repo's own
 * test machinery exported into `bun test` processes by the runners and CI
 * workflows (must survive), so it is stripped through the keep-lists below.
 * A blanket GBRAIN_* delete would break that machinery — e.g. the e2e lane's
 * GBRAIN_DATABASE_URL target or the snapshot fast path.
 *
 * The keep-lists, the renamed-opt-in map and the naming rule for test opt-ins
 * live in ./operator-env-policy.ts, shared with
 * scripts/check-test-env-opt-ins.ts.
 *
 * Escape hatch: GBRAIN_TEST_KEEP_AMBIENT_ENV=1 disables the scrub entirely
 * (it lives under GBRAIN_TEST_, so it survives its own scrub). Debugging:
 * GBRAIN_DEBUG_PRELOAD=1 logs the removed NAMES — never values, which may be
 * secrets.
 */

import { isStripped, renamedOptInMessage } from './operator-env-policy';

// Old opt-in names fail fast BEFORE the scrub (and regardless of
// GBRAIN_TEST_KEEP_AMBIENT_ENV): the scrub would otherwise delete them and the
// gated tests would skip silently.
for (const [name, value] of Object.entries(process.env)) {
  if (value === undefined || value === '') continue;
  const message = renamedOptInMessage(name, value);
  if (!message) continue;
  console.error(`[operator-env-preload] ${message}`);
  process.exit(2);
}

if (process.env.GBRAIN_TEST_KEEP_AMBIENT_ENV !== '1') {
  const removed: string[] = [];
  for (const name of Object.keys(process.env)) {
    if (!isStripped(name)) continue;
    delete process.env[name];
    removed.push(name);
  }
  if (process.env.GBRAIN_DEBUG_PRELOAD === '1' && removed.length > 0) {
    console.error(
      `[operator-env-preload] cleared ${removed.length}: ${removed.sort().join(', ')}`,
    );
  }
}

if (process.env.GBRAIN_NO_SNAPSHOT === '1') {
  delete process.env.GBRAIN_PGLITE_SNAPSHOT;
  delete process.env.GBRAIN_TEST_DEFAULT_SNAPSHOT;
}
