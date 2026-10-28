# GBRA-47 lane B: red nightlies and visibility (W1 + W3)

Branch `gbra47/lane-b`, cut from the collector `capy/gbra47-test-ci-wave` (master 6622a119e).
Finding IDs point into the audit lane reports (A-infrequent, B-flakes, C-ci-optimize).

## Folded-in commits from Foundations 2 Lane F (GBRA-40)

Cherry-picked with `-x`, authorship kept, in this order: 3565852b7 (scale `find_orphans`
known answer reads totals and one maximal page: A5), b48a9a29c (PGLite planner stats
refresh during the database timeline walk), 854ca64a3 + f60b82cfe (autocommit writes take
the #5449 WAL checkpoint guard, probe issued behind the write so issue order holds),
d3bafdf5f (engine-sql baseline row follows the probe into `issueProbe`). The
`pglite-engine.ts` module-size ceiling is 2930 (from f60b82cfe). Their tests pass here:
`test/scripts/scale-orphans-verifier.test.ts`, `test/extract-timeline-db-planner-stats.test.ts`,
`test/pglite-checkpoint-guard.test.ts`, plus the three suites 854ca64a3 alone regressed
(`test/hybrid-cache-scope-poison.serial.test.ts`, `test/engine-surface-coverage.test.ts`,
`test/export-surface-golden.test.ts`): 40 pass, 0 fail.

## Retirements

None. No test was deleted or retired in this lane.

Changed assertions (intended behavior changes, not weakened):

| File | Change | Why |
|---|---|---|
| `test/scripts/data-safety-native-workflow.test.ts` | the pinned `SOAK_OPERATIONS` expression now includes `merge_group` | D-3/DX-11: merge-queue runs use the PR profile (2,500-write soak) |
| `test/e2e/codex-plugin-install-real.serial.test.ts` | oracle uses `isCallable`; cold home asserts STATUS-ONLY exit 0 plus the `--fail-fast` refusal | A3: the old oracle and the cold-home exit predate #5891/#5991 (`codex_door_fix.diff`) |

## New regression tests and their discriminating mutations

Every mutation below was applied, the named test failed, and the code was restored.

| Test | Mutation | Result |
|---|---|---|
| `test/scripts/postinstall-standalone.test.ts` | restore the static `import … from '../src/core/runtime-version.ts'` in `scripts/postinstall.ts` | fails: `Cannot find module '../src/core/runtime-version.ts'` |
| `test/scripts/run-heavy.test.ts` | restore abort-on-first-failure in `scripts/run-heavy.sh` | fails (later scripts never ran) |
| `test/scripts/scale-watchdog.test.ts` | kill only the child, not its process group | fails (the grandchild survives) |
| `test/scripts/scale-trend.test.ts` (new case) | promotion check back to "any 20k report passed" | fails (a missing PGLite report promotes) |
| `test/scripts/nightly-issue.test.ts` | close on any green run (drop the previously-failing-jobs check) | fails (skip-green closes) |
| same | drop `@` neutralisation in `inert()` | fails (mention renders) |
| same | known-red signature always matches | fails (new error text tracked as known-red) |
| `test/scripts/ci-manifest-diff.test.ts` | version-only ignores whether anything changed | fails |
| same | `ci-dependency-audit.sh` always blocks | fails (advisory-only PR exits 1) |
| `test/scripts/e2e-provider-key-notice.test.ts` | stop checking ANTHROPIC_API_KEY | fails |
| `test/scripts/ci-health-report.test.ts` | treat fork runs as same-repo | fails |
| `test/scripts/regen-all.test.ts` | `--check` never records a stale artifact | fails |
| `test/release-workflow.test.ts` (new case) | publish-template gate back to a plain `SKIP:` line | fails |
| `test/scripts/heavy-door-workflow.test.ts` (new cases) | drop `if: ${{ !cancelled() }}` from the Claude plugin door | fails |
| `test/scripts/ci-pr-scope.test.ts` (new cases) | merge-group runs on the full matrix / version-only diff widens native scope | fail by assertion (cells and scope compared exactly) |

## Verification

- `bun run verify`: 70/70 checks green (adds `check:regen-all`). `bun run typecheck` clean.
- `bash tests/docker/bootstrap-e2e.sh`: PASS (A2/A16).
- Local plugin doors (codex 0.147.0, claude-code 2.1.233, Bun 1.4.2): Codex door 1 pass 1 skip; Claude door 2 pass 1 skip (A3).
- Heavy Tests dispatched on the branch, run 37222515065: every job green; Hermes paid leg and real-agent doors visibly skipped with owner-only fix annotations. The earlier dispatch 37221093567 lost the Hermes installer download to four raw.githubusercontent 429s, fixed by spaced retries.
- Scale tier dispatched at 20k, run 37221090928 (head 5a3848a69, before f60b82cfe): both cells green. PGLite: import_files 117 s, extract 128 s, vectors 173 s (500-page batches 2.1 s growing to 6.3 s, dimension 1024, RSS ~2.5 GiB); Postgres vectors 56 s. The 36-minute PGLite `vectors` stall of nightly 37196223708 does not reproduce, so no known-red row is kept for it; the X5 TODO records the numbers.
- Semgrep dispatched on the branch, run 37221645321: `semgrep-full` green, SARIF uploaded.
- `bun scripts/nightly-issue.ts --dry-run` against Heavy Tests 37195155240 (red: three failing jobs, owner action for the Hermes secret, last green 31683538558's SHA) and macOS 26 validation 37197810506 (green, no action).
- `bun run regen:all` twice: the second run changes nothing.
