#!/usr/bin/env bash
# scripts/ci-changed-files.sh — the changed files of the pull request or
# merge-group entry that triggered this workflow run, one per line, from the
# GitHub API (no git history needed, so the checkout stays shallow).
#
# Exits 1 with the reason on stderr whenever the list cannot be complete, so
# callers fail closed (prepare-e2e then runs the full E2E corpus):
#   - no pull_request or merge_group context (push, schedule, dispatch);
#   - an unknown or capped size: the pull request files API returns at most
#     3000 files and the compare API at most 300;
#   - an API error, or a paginated list shorter than the PR's changed_files.
#
# Env: EVENT, REPO, GH_TOKEN; PR + CHANGED_FILES (pull_request);
#      BASE_SHA + HEAD_SHA (merge_group).
set -euo pipefail

fail() { echo "ci-changed-files: $*" >&2; exit 1; }

case "${EVENT:-}" in
  pull_request)
    [[ "${CHANGED_FILES:-}" =~ ^[0-9]{1,4}$ ]] || fail "changed-file count unknown (${CHANGED_FILES:-unset})"
    [ "$CHANGED_FILES" -lt 3000 ] || fail "the pull request changes $CHANGED_FILES files; the files API lists at most 3000"
    files=$(gh api --paginate "repos/${REPO:?}/pulls/${PR:?}/files?per_page=100" --jq '.[].filename') || fail "pull request files API failed"
    listed=$(printf '%s\n' "$files" | awk 'NF { n++ } END { print n+0 }')
    [ "$listed" -eq "$CHANGED_FILES" ] || fail "the files API listed $listed of $CHANGED_FILES changed files"
    ;;
  merge_group)
    files=$(gh api "repos/${REPO:?}/compare/${BASE_SHA:?}...${HEAD_SHA:?}" --jq 'if (.files | length) >= 300 then error("capped") else .files[].filename end') \
      || fail "compare API failed or capped at 300 files"
    ;;
  *)
    fail "no pull request or merge-group context (event: ${EVENT:-unset})"
    ;;
esac
[ -z "$files" ] || printf '%s\n' "$files"
