#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
# Pinned downloads are kept by content hash, so a CI cache or a second run reuses them; a cached file is used only when its
# hash still matches, and every file is hash-checked whichever way it arrived.
CACHE="${GBRAIN_VENDOR_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/gbrain-vendor}"
digest() { if command -v "sha$1sum" >/dev/null 2>&1; then "sha$1sum" "$2"; else shasum -a "$1" "$2"; fi | cut -d' ' -f1; }
fetch() {
  local url="$1" dest="$2" bits="$3" want="$4"
  if [[ -f "$CACHE/$want" && "$(digest "$bits" "$CACHE/$want")" == "$want" ]]; then cp "$CACHE/$want" "$dest"; return; fi
  # Bounded retries with curl's own exponential backoff (1, 2, 4, 8 s): a transient registry or GitHub failure is retried,
  # a missing file or a hash mismatch is not.
  curl -fsSL --retry 4 --retry-all-errors --connect-timeout 20 --max-time 120 "$url" -o "$dest"
  if [[ "$(digest "$bits" "$dest")" != "$want" ]]; then echo "update-postgres: $url does not match its pinned SHA-$bits" >&2; exit 1; fi
  mkdir -p "$CACHE" && cp "$dest" "$CACHE/$want.$$" && mv "$CACHE/$want.$$" "$CACHE/$want" || true
}
fetch https://registry.npmjs.org/postgres/-/postgres-3.4.9.tgz "$WORK/upstream.tgz" 512 \
  183dea741d31d73f7180523a71d443eb1bb64a9d9608e1287b79ad9f207911ed17aeb2f93def9ee020a726b44c9cbd7362d44366641055bbceb6d2e72832e76b
mkdir "$WORK/postgres"
tar -xzf "$WORK/upstream.tgz" --strip-components=1 -C "$WORK/postgres"
patch --no-backup-if-mismatch -d "$WORK/postgres" -p1 < "$ROOT/patches/postgres@3.4.9.patch"
awk '/^diff --git / { keep = ($3 ~ /^a\/src\//) } keep' "$ROOT/patches/postgres@3.4.9.patch" |
  sed 's|a/src/|a/cf/src/|g; s|b/src/|b/cf/src/|g' > "$WORK/cf.patch"
patch --no-backup-if-mismatch -d "$WORK/postgres" -p1 < "$WORK/cf.patch"
fetch https://raw.githubusercontent.com/porsager/postgres/v3.4.9/UNLICENSE "$WORK/postgres/UNLICENSE" 256 \
  b5065838cbac452dfc855ba6e6e031481ad2c68406f70d21ead9321374653e6c
if [[ "${1:-}" == '--check' ]]; then
  diff -ru "$ROOT/vendor/postgres" "$WORK/postgres"
elif [[ $# -eq 0 ]]; then
  rm -rf "$ROOT/vendor/postgres"
  cp -R "$WORK/postgres" "$ROOT/vendor/postgres"
else
  echo 'Usage: bash vendor/update-postgres.sh [--check]' >&2
  exit 2
fi
