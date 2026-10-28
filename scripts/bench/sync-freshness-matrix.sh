#!/usr/bin/env bash
# GBRA-133 lane A: the cell sets behind docs of scripts/bench/sync-freshness.ts.
#   scripts/bench/sync-freshness-matrix.sh <core|rtt|pollers|extras|embed|big|backlog|noop|pr4b|pr2b6|pr2b6-before> [work-dir] [checkout]
#   SKIP_EXISTING=1 resumes a set: cells whose result JSON exists are skipped.
#   pr2b6 takes an engine in ENGINE=postgres|pglite (default both); pr2b6-before runs the comparison cells against [checkout]
#   (the merge base before PR 2a) and then against this checkout, back to back on one machine.
# Cells run one at a time (they share the CPU). Each writes <work-dir>/results/<cell>.json;
# render the table with: bun scripts/bench/sync-freshness.ts --report <work-dir>/results
set -uo pipefail
SET=${1:?set}; W=${2:-$PWD/.context/bench/sync-freshness}; PR4B=${3:-}
B="bun $(dirname "$0")/sync-freshness.ts --work-dir $W ${SKIP_EXISTING:+--skip-existing}"
run() { echo "== $*" >&2; $B "$@" 2>&1 | grep -E '^\[freshness' | grep -E 'wrote|ERROR|never|cell ' >&2 || true; }
case "$SET" in
  core)
    for P in 1000 10000; do for E in postgres pglite; do for M in classic managed; do
      run --engine $E --mode $M --pages $P --commit single --trigger manual --reps 20
      run --engine $E --mode $M --pages $P --commit batch --trigger manual --reps 10
      if [ $M = managed ]; then
        run --engine $E --mode $M --pages $P --commit single --trigger serve --reps 20
        run --engine $E --mode $M --pages $P --commit batch --trigger serve --reps 10
      else
        run --engine $E --mode $M --pages $P --commit single --trigger serve --reps 1 --timeout 60
      fi
    done; done; done ;;
  rtt)
    for M in classic managed; do
      run --engine postgres --mode $M --pages 10000 --commit single --trigger manual --reps 20 --rtt 57
      run --engine postgres --mode $M --pages 10000 --commit batch --trigger manual --reps 10 --rtt 57
    done
    run --engine postgres --mode managed --pages 10000 --commit single --trigger serve --reps 20 --rtt 57
    run --engine postgres --mode managed --pages 10000 --commit batch --trigger serve --reps 10 --rtt 57 ;;
  pollers)
    run --engine postgres --mode managed --pages 10000 --commit single --trigger jobs --reps 10
    run --engine postgres --mode classic --pages 10000 --commit single --trigger jobs --reps 10
    run --engine postgres --mode classic --pages 10000 --commit single --trigger watch --interval 60 --reps 6
    run --engine postgres --mode managed --pages 10000 --commit single --trigger watch --interval 60 --reps 6
    run --engine postgres --mode managed --pages 10000 --commit single --trigger autopilot --reps 4 ;;
  extras)
    run --engine postgres --mode managed --pages 10000 --commit single --trigger serve --scenario during-sync --reps 5
    run --engine pglite --mode managed --pages 10000 --commit single --trigger serve --scenario during-sync --reps 5 ;;
  embed)
    for M in classic managed; do for L in 200 2000; do
      run --engine postgres --mode $M --pages 1000 --commit single --trigger manual --reps 5 --embed stub --embed-latency-ms $L --timeout 120
    done; done
    run --engine postgres --mode managed --pages 1000 --commit single --trigger serve --reps 5 --embed stub --embed-latency-ms 200 --timeout 120
    run --engine postgres --mode managed --pages 1000 --commit single --trigger serve --reps 5 --embed stub --embed-latency-ms 2000 --timeout 120 ;;
  big)
    for E in postgres pglite; do for M in classic managed; do
      run --engine $E --mode $M --pages 100000 --commit single --trigger manual --reps 10
      [ $M = managed ] && run --engine $E --mode $M --pages 100000 --commit single --trigger serve --reps 10
    done; done
    for M in classic managed; do run --engine postgres --mode $M --pages 100000 --commit single --trigger manual --reps 10 --rtt 57; done
    run --engine postgres --mode managed --pages 100000 --commit single --trigger serve --reps 10 --rtt 57 ;;
  backlog)
    for P in 10000 100000; do for E in postgres pglite; do for M in classic managed; do
      run --engine $E --mode $M --pages $P --commit backlog --trigger manual --reps 2
    done; done; done ;;
  noop)
    for P in 10000 100000; do
      run --engine postgres --mode managed --pages $P --commit noop --trigger manual --reps 10 --trace
      run --engine pglite --mode managed --pages $P --commit noop --trigger manual --reps 10
    done
    run --engine postgres --mode managed --pages 10000 --commit noop --trigger manual --reps 10 --trace --rtt 57 ;;
  pr4b)
    : "${PR4B:?pr4b checkout path}"
    for ROOT in "$(cd "$(dirname "$0")/../.." && pwd)" "$PR4B"; do
      run --gbrain-root "$ROOT" --engine postgres --mode managed --pages 10000 --commit single --trigger manual --reps 20
      run --gbrain-root "$ROOT" --engine postgres --mode managed --pages 10000 --commit single --trigger serve --reps 20
      run --gbrain-root "$ROOT" --engine postgres --mode managed --pages 10000 --commit single --trigger manual --reps 20 --rtt 57
      run --gbrain-root "$ROOT" --engine postgres --mode managed --pages 10000 --commit single --trigger serve --reps 20 --rtt 57
      run --gbrain-root "$ROOT" --engine pglite --mode managed --pages 10000 --commit single --trigger manual --reps 20
      run --gbrain-root "$ROOT" --engine pglite --mode managed --pages 10000 --commit single --trigger serve --reps 20
    done ;;
  pr2b6)
    # GBRA-133 PR 2b.6. Every resident cell names its detection mode; p95 needs n >= 40, so the poll/watch cells run 40.
    for E in ${ENGINE:-postgres pglite}; do
      for M in managed classic; do
        for D in watch poll; do run --engine $E --mode $M --pages 10000 --commit single --trigger serve --detection $D --jitter-ms 3000 --reps 40; done
        run --engine $E --mode $M --pages 10000 --commit single --trigger serve --embed stub --embed-latency-ms 200 --reps 20
        run --engine $E --mode $M --pages 10000 --commit single --trigger serve-boot --reps 20
        run --engine $E --mode $M --pages 10000 --scenario embed-drain --trigger serve --embed stub --embed-latency-ms 50 --reps 10
        run --engine $E --mode $M --pages 10000 --sources 3 --scenario fairness --residents serve --reps 10
      done
      run --engine $E --mode managed --pages 10000 --scenario embed-drain --trigger serve --embed stub --embed-latency-ms 50 --stub-fail-ms 30000 --reps 10
      run --engine $E --mode managed --pages 10000 --scenario embed-drain --trigger serve --embed keyless-stub --reps 10
      run --engine $E --mode managed --pages 10000 --sources 5 --scenario fairness --residents serve --reps 10
      run --engine $E --mode managed --pages 10000 --scenario idle --residents serve
      run --engine $E --mode managed --pages 10000 --sources 3 --scenario idle --residents serve
      if [ $E = postgres ]; then
        run --engine $E --mode managed --pages 10000 --sources 3 --scenario fairness --residents serve,jobs,autopilot --reps 10
        run --engine $E --mode managed --pages 10000 --sources 3 --scenario idle --residents serve,jobs,autopilot
        run --engine $E --mode managed --pages 10000 --scenario idle --residents jobs
      fi
    done ;;
  pr2b6-before)
    : "${PR4B:?checkout of the merge base before PR 2a}"
    for ROOT in "$PR4B" "$(cd "$(dirname "$0")/../.." && pwd)"; do
      run --gbrain-root "$ROOT" --engine postgres --mode managed --pages 10000 --commit single --trigger serve --embed stub --embed-latency-ms 200 --reps 20
      run --gbrain-root "$ROOT" --engine postgres --mode managed --pages 10000 --commit single --trigger serve-boot --reps 20
      run --gbrain-root "$ROOT" --engine postgres --mode managed --pages 10000 --sources 3 --scenario fairness --residents serve --reps 10
      run --gbrain-root "$ROOT" --engine postgres --mode managed --pages 10000 --scenario idle --residents serve
      run --gbrain-root "$ROOT" --engine postgres --mode managed --pages 10000 --sources 3 --scenario idle --residents serve,jobs,autopilot
      run --gbrain-root "$ROOT" --engine pglite --mode managed --pages 10000 --commit single --trigger serve-boot --reps 20
      run --gbrain-root "$ROOT" --engine pglite --mode managed --pages 10000 --commit single --trigger serve --embed stub --embed-latency-ms 200 --reps 20
    done ;;
  *) echo "unknown set $SET" >&2; exit 2 ;;
esac
