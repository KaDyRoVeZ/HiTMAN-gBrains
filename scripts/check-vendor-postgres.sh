#!/usr/bin/env bash
# The vendored postgres.js driver ships three copies (vendor/postgres src, cjs/src and cf/src), all built from the pinned
# upstream tarball plus patches/postgres@3.4.9.patch. vendor/update-postgres.sh --check rebuilds them and compares every
# byte, so a fix made in one copy but missing from the patch or the other two copies fails here.
# The rebuild downloads from the npm registry and GitHub: under CI an unreachable download fails the check; on a machine
# without network it is a recorded skip (GBRAIN_CHECK_SKIPPED), never a pass.
# Wired into bun run verify (single guard registry: scripts/guards-manifest.tsv).
set -uo pipefail
cd "$(dirname "$0")/.."
log=$(mktemp)
trap 'rm -f "$log"' EXIT
if bash vendor/update-postgres.sh --check >"$log" 2>&1; then
  echo "check-vendor-postgres: vendor/postgres matches upstream plus patches/postgres@3.4.9.patch"
  exit 0
fi
if grep -q '^curl: (' "$log"; then
  if [[ -z "${CI:-}" ]]; then
    echo "GBRAIN_CHECK_SKIPPED: the pinned upstream download failed (no network?); vendor/postgres was not compared"
    exit 0
  fi
  cat "$log"
  echo "check-vendor-postgres: the pinned upstream download failed, so vendor/postgres was not compared; rerun once the npm registry and GitHub are reachable." >&2
  exit 1
fi
grep -vE '^(patching file |Hunk #[0-9]+ succeeded)' "$log"
echo "check-vendor-postgres: vendor/postgres and patches/postgres@3.4.9.patch disagree." >&2
echo "Fix: make the change in vendor/postgres/src, regenerate patches/postgres@3.4.9.patch from it, then run" >&2
echo "  bash vendor/update-postgres.sh (rewrites the cjs and cf copies) and commit all of vendor/postgres (vendor/README.md)." >&2
exit 1
