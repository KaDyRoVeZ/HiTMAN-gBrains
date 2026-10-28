#!/usr/bin/env bash
# scripts/ci-manifest-diff.sh — parsed-JSON classification of manifest diffs
# for CI path scoping (GBRA-47 B11, C11; ENG-17).
#
#   bash scripts/ci-manifest-diff.sh version-only <base.json> <head.json>
#     prints `true` when the two files differ only in their top-level
#     "version" (every other key equal after parsing), else `false`.
#   bash scripts/ci-manifest-diff.sh dependency-change <base.json> <head.json>
#     prints `true` when any dependency field differs (dependencies,
#     devDependencies, optionalDependencies, peerDependencies, overrides,
#     resolutions, trustedDependencies, patchedDependencies), else `false`.
#   bash scripts/ci-manifest-diff.sh drop-version-only < changed-files
#     filters a changed-file list (one path per line): package.json and
#     openclaw.plugin.json entries whose change is version-only are dropped.
#     Reads both revisions with `gh api` (env REPO, BASE_SHA, HEAD_SHA).
#   bash scripts/ci-manifest-diff.sh dependency-scope < changed-files
#     prints `blocking=true|false` and `reason=...` for the dependency-audit
#     job: true when bun.lock, admin/bun.lock or patches/ changed, or when a
#     package.json's dependency fields changed (env as above).
#
# Fails closed: a file that cannot be read or parsed is never version-only
# and always counts as a dependency change, so an unknown diff never narrows
# validation.
set -euo pipefail

DEP_FIELDS='{dependencies, devDependencies, optionalDependencies, peerDependencies, overrides, resolutions, trustedDependencies, patchedDependencies}'

same_after() {
  local filter="$1" base="$2" head="$3" a b
  a=$(jq -S "$filter" "$base" 2>/dev/null) || return 2
  b=$(jq -S "$filter" "$head" 2>/dev/null) || return 2
  [ "$a" = "$b" ]
}

version_only() {
  if same_after 'del(.version)' "$1" "$2" && ! same_after '.' "$1" "$2"; then echo true; else echo false; fi
}

dependency_change() {
  if same_after "$DEP_FIELDS" "$1" "$2"; then echo false; else echo true; fi
}

fetch_pair() {
  local path="$1" dir="$2"
  [ -n "${REPO:-}" ] && [ -n "${BASE_SHA:-}" ] && [ -n "${HEAD_SHA:-}" ] || return 1
  gh api -H 'Accept: application/vnd.github.raw' "repos/$REPO/contents/$path?ref=$BASE_SHA" > "$dir/base.json" 2>/dev/null || return 1
  gh api -H 'Accept: application/vnd.github.raw' "repos/$REPO/contents/$path?ref=$HEAD_SHA" > "$dir/head.json" 2>/dev/null || return 1
}

mode="${1:-}"
case "$mode" in
  version-only) version_only "$2" "$3" ;;
  dependency-change) dependency_change "$2" "$3" ;;
  drop-version-only)
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    while IFS= read -r path || [ -n "$path" ]; do
      case "$path" in
        package.json|*openclaw.plugin.json)
          if fetch_pair "$path" "$tmp" && [ "$(version_only "$tmp/base.json" "$tmp/head.json")" = true ]; then
            continue
          fi
          ;;
      esac
      printf '%s\n' "$path"
    done
    ;;
  dependency-scope)
    tmp=$(mktemp -d)
    trap 'rm -rf "$tmp"' EXIT
    files=$(cat)
    if [ -z "$files" ]; then
      printf 'blocking=true\nreason=the changed-file list is empty or unreadable\n'
      exit 0
    fi
    if hit=$(grep -E -m1 '^(bun\.lock|admin/bun\.lock|patches/)' <<< "$files"); then
      printf 'blocking=true\nreason=%s changed\n' "$hit"
      exit 0
    fi
    while IFS= read -r path; do
      case "$path" in
        package.json|admin/package.json)
          if ! fetch_pair "$path" "$tmp" || [ "$(dependency_change "$tmp/base.json" "$tmp/head.json")" = true ]; then
            printf 'blocking=true\nreason=%s dependency fields changed (or could not be read)\n' "$path"
            exit 0
          fi
          ;;
      esac
    done <<< "$files"
    printf 'blocking=false\nreason=no lockfile, patches/ or dependency-field change\n'
    ;;
  *)
    echo "Usage: bash scripts/ci-manifest-diff.sh version-only|dependency-change <base.json> <head.json>" >&2
    echo "       bash scripts/ci-manifest-diff.sh drop-version-only|dependency-scope < changed-files" >&2
    exit 2
    ;;
esac
