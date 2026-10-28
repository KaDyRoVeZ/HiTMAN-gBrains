#!/usr/bin/env bash
# Classify a pull request's changed files (one path per line on stdin) for the
# native writer-lock workflow. Prints `primary` when any path can change native
# lock, IPC, publication, backup, export or sync behavior (every native target
# runs on the primary Bun version), otherwise `smoke` (only the Linux x64 glibc
# cell runs). An empty or unreadable list prints `primary`: an unknown diff
# never narrows validation. Pushes, schedules and manual runs never call this;
# they always run the full matrix.
set -euo pipefail

NATIVE_PATHS='^(native/|scripts/native/|src/core/persistence/|src/core/context/|test/fixtures/native|\.github/workflows/(native-locks|test)\.yml$|package\.json$|bun\.lock$|openclaw\.plugin\.json$|docker-compose\.ci\.yml$)|^src/core/(pglite-[^/]*|engine|postgres-engine|sync[^/]*|export-[^/]*|import-file|markdown|write-through|page-lock)\.ts$|^src/commands/(backup|export|restore|sync)[^/]*\.ts$|openclaw|native|-lock|local-ipc-path|persistence-(publication|git-publication|sync-origin)|backup-portability|export-publication'

files=$(cat) || { echo primary; exit 0; }
# Consume the full input: grep -q closes an early match's pipe and printf
# then fails with SIGPIPE under pipefail, incorrectly selecting smoke.
if [ -z "$files" ] || grep -E "$NATIVE_PATHS" >/dev/null <<< "$files"; then
  echo primary
else
  status=$?
  if [ "$status" -eq 1 ]; then echo smoke; else echo primary; fi
fi
