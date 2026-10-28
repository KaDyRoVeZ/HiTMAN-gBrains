#!/usr/bin/env bash
# CI guard: every text file under src/, test/, and the repo root .yml/.md
# files must end with a newline. POSIX-noncompliant trailing data shows up
# as a phantom diff on every future edit and trips most linters.
#
# Sibling to scripts/check-progress-to-stdout.sh and
# scripts/check-jsonb-pattern.sh per CLAUDE.md's CI guard pattern.
# Wired into `bun run verify` (check:newlines).
#
# Guard fixtures under test/fixtures/guards/ are skipped: their known-bad
# trees deliberately lack the newline. Seam: GBRAIN_GUARD_ROOT scans a fixture
# tree with find instead of git ls-files.

set -euo pipefail

cd "${GBRAIN_GUARD_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"

# Files to check: anything tracked under src/ + test/ that's a code/text file.
# Also the top-level *.yml + *.md the repo controls. Portable to bash 3.2
# (macOS default) — no mapfile, no associative arrays.
if [ -n "${GBRAIN_GUARD_ROOT:-}" ]; then
  files=$(find . -type f \( -name '*.ts' -o -name '*.js' -o -name '*.json' -o -name '*.sql' -o -name '*.md' -o -name 'gbrain.yml' \) | sed 's#^\./##' | sort -u)
else
  files=$(
    git ls-files \
      'src/**/*.ts' 'src/**/*.js' 'src/**/*.json' 'src/**/*.sql' 'src/**/*.md' \
      'test/**/*.ts' 'test/**/*.js' 'test/**/*.json' 'test/**/*.md' \
      'gbrain.yml' '*.md' \
    2>/dev/null | grep -v '^test/fixtures/guards/' | sort -u
  )
fi

missing=""
total=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || continue
  [ -s "$f" ] || continue
  total=$((total + 1))
  if [ -n "$(tail -c 1 "$f")" ]; then
    missing="${missing}  $f"$'\n'
  fi
done <<< "$files"

if [ -n "$missing" ]; then
  echo "ERROR: the following files are missing a trailing newline:" >&2
  printf '%s' "$missing" >&2
  echo >&2
  echo "Fix: append a newline. e.g. \`printf '\\n' >> <file>\` or your editor's" >&2
  echo "'final newline' setting (most editors do this automatically)." >&2
  exit 1
fi

echo "trailing-newline check: ok ($total files)"
