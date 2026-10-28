# Lane S6: CI speed and cost (GBRA-47 W4)

C1, C2 (the ratchet check; the weight re-mine follows from the collector's own
green run), C3, C4, C5, C6, C8, E6/B10 and E7. Probe edits were reverted after
each run. Executed-identity changes are declared in `../expected-deltas.tsv`.

## What changed

| Item | Change | Executed-identity effect |
|---|---|---|
| C3 | `E2E_EXCLUSIONS` includes every `test/e2e/` row of `scripts/e2e-backend-matrix.txt` (`BACKEND_MATRIX_OWNED`); `prepare` prints `excluded: <file> (owned by the Tier 1 backend matrix, scripts/e2e-backend-matrix.txt)` | 31 files move from lane `e2e` (arm `postgres-direct`) to lane `backend-matrix`, which already ran them on both arms; 31 `move` rows |
| C5 | The backend-matrix step leaves Tier 1 for its own `tier1-backend-matrix` job (4 vCPU, postgres + pgbouncer, `GBRAIN_CI_REQUIRE_PGBOUNCER=1`, artifact `receipts-tier1-backend-matrix`), required by `e2e-status`; Tier 1 keeps 16 vCPU and loses the pgbouncer service | none (lane `backend-matrix` unchanged; `receipts-tier1` still exists) |
| C6 | `scripts/e2e-test-map.ts` and `test/fixtures/e2e-unmapped-baseline.txt` deleted; `select-e2e.ts` keeps DOC_ONLY -> nothing, else all, and reads `--changed-files`; `prepare-e2e` drops `fetch-depth: 0` and lists files with `scripts/ci-changed-files.sh` (PR files API, 3000 cap; compare API, 300 cap), failing closed to the whole corpus; `ci:local:diff` / `ci:ubicloud:diff` run gitleaks + `scripts/ci-doc-checks.sh` on doc-only diffs and the full gate otherwise | selector/wiring unit tests retired or renamed (rows below) |
| C1 | `MAX_E2E_WORKERS = 8`; `selected-e2e` on `ubicloud-standard-2` | e2e lane now has up to 8 shards (new `receipts-e2e-5..8` artifacts) |
| C4 | unit `test` shards on `ubicloud-standard-2` | none |
| C8 | `serial-tests` on `ubicloud-standard-4` | none |
| E6/B10 | job `slow-eval-longmemeval` deleted; `test-shard.sh` packs `eval-longmemeval-e2e.slow.test.ts` (seeded weight 8741 ms from the Ubicloud map); coverage `--manifest-expect` drops `sloweval`; `needs`, test-status echo and cache-key home count updated; the nightly `coverage-full-slow` no longer runs it (the full unit shards do) | `move slow -> unit` + `job receipts-slow-eval` |
| E7 | `check:eval-chronicle` leaves `run-verify-parallel.sh` (canary-style comment); package script kept | `retire verify check:eval-chronicle` |
| C2 | `scripts/check-weight-coverage.ts` (`check:weight-coverage`, in verify, guard self-test fixtures): dead entries fail everywhere; unweighted share (unit > 5%, serial/E2E > 10%) warns with the miner command (stdout + step summary) and fails only when `GITHUB_EVENT_NAME=schedule`. Dead entries pruned so the check passes: 61 serial (D6 renames and older deletions), 1 E2E (`zeroentropy-live`), 70 Ubicloud | additions only |

## Retirements

<a id="e7-check-eval-chronicle"></a>
### E7: `check:eval-chronicle` in verify

| Removed execution | Evidence case | Probe edit | Result | Surviving owner | Owner result |
|---|---|---|---|---|---|
| verify check `check:eval-chronicle` (lane `verify`) | Retained contract, same boundary | `src/core/engine-sql/timeline.ts` `getLastSeen`: pass `null` as `last_date` to `finalizeLastSeen` | (verify check not run; E-evals section 3 recorded it failing the same mutation with `FAIL last_seen — last_date=null`) | `test/eval-chronicle.test.ts` (unit matrix, every PR and push; exact 6/6 gate through the same `runChronicleEval`) | fails, 0 pass / 1 fail, `last_seen: last_date=null` (2026-10-04, this branch) |

<a id="c6-selector-narrowing"></a>
### C6: selector narrowing and its ratchet

Intentionally abandoned contract (approved recommendation, decision "retire
select-e2e narrowing"). Reachability: `E2E_TEST_MAP`, `matchGlob`, the escape
hatches and `persistenceOwnedNotices` are deleted with `scripts/e2e-test-map.ts`;
no production caller remains (`git grep E2E_TEST_MAP` is empty outside history).
The map selected every E2E file on 30/30 sampled PR runs and 40/40 merged PRs
(lane C, C6). User-facing promises updated: CONTRIBUTING.md ("Hand-tune narrower
mappings" removed), AGENTS.md, docs/RELEASING.md, docs/TESTING.md, KEY_FILES.

| Retired tests | Surviving owner of what remains |
|---|---|
| `test/select-e2e.test.ts` › `matchGlob` (4), narrowing `selectTests` cases (26), `persistenceOwnedNotices` (4) | `test/select-e2e.test.ts` › `classify` (4, same names) and new `selectTests` / `selector CLI` cases; persistence ownership notices: `test/scripts/e2e-matrix.test.ts` › "drops the persistence-validation.yml crash suites and names their owner" |
| `test/scripts/e2e-wiring.test.ts` › `e2e file claim ratchet` (5) | `test/scripts/e2e-wiring.test.ts` › `e2e file ownership` (every e2e file selected or owned by a named job; every exclusion exists) |

## New tests and guards: discriminating mutations

| Test / guard | Probe edit | Observed failure |
|---|---|---|
| `e2e-wiring` › "a truncated pull request list fails closed to the whole corpus" | remove the listed-vs-`changed_files` comparison in `scripts/ci-changed-files.sh` | 1 fail: the doc-only partial list selected nothing instead of all |
| `e2e-wiring` › "a file excluded without an owning job fails the ownership check" | fixture exclusion `test/e2e/fixture-unowned.test.ts` | `owner()` returns null (in-suite fixture) |
| `scripts/ci-doc-checks.sh` (DX-2 verify) | append a line to `docs/guides/live-sync.md` (inlined in llms-full.txt) without `bun run build:llms` | rc=1, `FAIL llms.txt + llms-full.txt are fresh`, `Fix: bun run build:llms`; rc=0 after revert |
| `check-weight-coverage.ts` | guard fixtures `bad` (dead unit entry), `bad-ubicloud` (dead Ubicloud entry); unit test: 2/20 unweighted on `pull_request` vs `schedule` | bad trees exit 1; PR run warns with exit 0 and writes the step summary; scheduled run exits 1 |
| `ci-local-rendering` › "a SRC/EMPTY/ERR diff says narrowing is retired and runs the full gate" | — (new behavior) | prints `E2E narrowing is retired; running the full E2E corpus (see docs/TESTING.md#e2e-selection)` and continues to the full gate |

## Local identity check

`bun scripts/ci-executed-counts.ts --base-dir <base receipts> --head-dir <head receipts> --deltas docs/test-audit/2026-10-04/expected-deltas.tsv`
over the nine touched unit test files (base = the collector before this lane,
head = this branch): PASS, 40 declared drops (37 retired, 3 moved), 32 additions.
The CI-level rows (C3 moves, E6 move + job row, E7 retirement) are proven only
by the wave PR's next run.
