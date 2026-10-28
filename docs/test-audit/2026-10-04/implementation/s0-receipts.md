# Lane S0: executed-test receipts and the identity ledger

Plan tasks: T0.1 (X2 receipts), T0.2 (`scripts/ci-executed-counts.ts`,
`expected-deltas.tsv`, report-only CI step), B9, B13, the run-e2e.sh part of
B2, and A9's missing-key summary line. No test was deleted or retired, so
there are no Retiring-a-test rows.

## What each lane writes

| Lane (identity) | Producer | CI artifact |
|---|---|---|
| `unit` | `scripts/test-shard.sh` (one bun per shard); locally `run-unit-shard.sh` (one bun per file) and `run-unit-parallel.sh` rescue passes (`kind=rescue`) | `receipts-unit-<n>` |
| `serial` | `scripts/run-serial-tests.sh`, one bun per file, rescue re-runs `kind=rescue` | `receipts-serial-<n>` |
| `slow` | `run-with-receipt.sh` in the three slow jobs; `run-slow-tests.sh` locally | `receipts-slow-eval`, `receipts-slow-perf`, `receipts-slow-brainbench` |
| `verify` | `run-verify-parallel.sh` (one testcase per check: pass, fail, timeout, skip) | `receipts-verify` |
| `verify-tests` | the bash 3.2 parser test in the verify job | `receipts-verify` |
| `shared-skills` | old-binary compatibility test | `receipts-shared-skills` |
| `e2e` | `run-e2e.sh` per file pass via `e2e-matrix.ts run`; an empty selection writes `declared_empty=1` | `receipts-e2e-<n>` |
| `backend-matrix` | `run-e2e.sh` in Tier 1 (`arm` = `postgres-direct` / `pgbouncer`) | `receipts-tier1` |
| `tier1`, `tier2`, `jsonb-parity` | `run-with-receipt.sh` per step | `receipts-tier1`, `receipts-tier2`, `receipts-jsonb-parity` |
| `full-unit`, `full-serial`, `full-e2e` | nightly coverage lanes | `receipts-full-*` |

Not receipted: the `security-regressions` matrix (the same files run in the
unit lane; Windows cells use PowerShell), the six inline `bun test` calls of
the nightly `coverage-full-slow` job, and `persistence-validation.yml` (owned
by another lane; its jobs are outside this lane's files).

## Rollout proof (X2: one shard first)

`GBRAIN_TEST_RECEIPT_DIR=… COVERAGE_DIR=… bun scripts/capture-test-log.ts --job 'test (8)' … -- bash scripts/test-shard.sh 8 8`
on Bun 1.4.2: exit 0, console output unchanged (`4215 pass / 9 skip / 0 fail`,
309 files), `coverage/shard/lcov.info` and `lane-manifest.json` written, and
the JUnit receipt read by the ledger as 309 files, 4215 executed, 9 skipped.
Bun's JUnit keeps `test.each` titles as the unformatted template (`… %s`),
so repeated names inside one file are numbered by occurrence (`name [#2]`).

A local Postgres run of four real E2E files (`run-e2e.sh` with receipts)
produced 19 executed identities, and the HOME sweep named the leaked B2 child:
`WARN: self-upgrade-marker.test.ts left processes running with HOME=… (killed): pid …: bun src/cli.ts check-update --refresh-cache`.

## Discriminating mutations

Each mutation was applied, the named test run, and the file restored.

| Mutation | Test that fails |
|---|---|
| rescue/rerun rank ignored | `completeness > a rescue supersedes the failing primary…`, `…killed shard re-run by its rescue…` |
| prior-attempt receipts accepted | `completeness > a receipt from an earlier run attempt is incomplete…` |
| JUnit declared-count check removed | `parseJUnit > a truncated or miscounted report throws…` |
| truncation check removed | `completeness > a truncated JUnit report is incomplete` |
| backend arms grouped together | `identity comparison > backend arms of one file are separate identities` |
| missing shard ignored | `completeness > a missing shard and a lane that executed nothing…` |
| move target not checked | `identity comparison > a declared file-level move passes only when…` |
| retirement without evidence accepted | `identity comparison > a retirement passes with its evidence row…` |
| repeated names merged | `parseJUnit > repeated names in one file … stay distinct identities` |
| run-e2e.sh back to bare `rm -rf` under `set -e` (B2) | `per-file HOME cleanup and receipts > a HOME that cannot be removed fails that file by name…` |
| HOME leak sweep removed | `…a child left running with the file HOME is killed before cleanup and named` |
| executed-files.txt green-only again (B9) | `sequential E2E runner > coverage keeps fresh processes…` |
| run-e2e.sh JUnit not kept as receipt | `…each file pass leaves a receipt with its native JUnit report…` |
| verify self-skip counted as pass | `run-verify-parallel.sh … records every check's real outcome…` |
| rescue pass writes no receipt | `run-unit-parallel.sh OOM rescue lane > writes a receipt per bun invocation…` |
| receipt variables not unset | `run-with-receipt.sh > records lane, files, exit…` (the wrapped test asserts it cannot see them) |
| capture collector not fed (B13) | all three `failure step summary (B13)` cases |
| timeout note not attached (B13) | `failure step summary (B13) > a timeout names the test…` |

## Existing tests changed

- `test/scripts/e2e-runner.test.ts`: three assertions pinned
  `executed-files.txt` as absent on a failed run. B9 changes that contract
  (the receipt is written pass or fail; `lane-manifest.json` stays
  green-only), so they now assert the file lists the attempted files while the
  manifest is still absent. The interrupted-run assertion is unchanged.
- `test/scripts/run-unit-shard.test.ts`: the sandbox stages
  `scripts/lib/test-env.sh`, which the runner now sources.

## Commands for T0.3

After a full run of test.yml and e2e.yml on one PR head (rerun all jobs, not
only failed ones):

```bash
# one side: per-lane table + completeness
bun scripts/ci-executed-counts.ts --head-run <test.yml run>,<e2e.yml run>
# baseline stability: identities must be identical across the three reruns
bun scripts/ci-executed-counts.ts --base-run <A test>,<A e2e> --head-run <B test>,<B e2e> --fail-on-additions --json b-vs-a.json
# acceptance: final wave SHA against the baseline
bun scripts/ci-executed-counts.ts --base-run <base test>,<base e2e> --head-run <head test>,<head e2e> --summary pr-table.md
```

Local artifact directories work the same with `--base-dir` / `--head-dir`
(a directory of `receipts-*` subdirectories or one receipts directory).
