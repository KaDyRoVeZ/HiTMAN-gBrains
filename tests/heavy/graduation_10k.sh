#!/usr/bin/env bash
# Engine graduation at 10,000 pages: builds (or restores from the fixture
# cache) the 10k history fixture, graduates it into a fresh Postgres test
# database through the agent flow (plan, confirm, green doctor) and writes the
# time-to-value report with per-phase timings and query p50/p95 on both
# engines. Reported, not gated (the 5-minute gate applies at 1k pages).
set -euo pipefail

source "$(dirname "$0")/_db_floor.sh"
cd "$(dirname "$0")/../.."

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[graduation_10k] DATABASE_URL not set; skipping (informational)." >&2
  exit 0
fi

LOG_DIR="${GBRAIN_HEAVY_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/gbrain-graduation-10k.XXXXXX")}"
mkdir -p "$LOG_DIR"
REPORT="$LOG_DIR/graduation-10k-$(date -u +%Y%m%d-%H%M%SZ).json"
echo "[graduation_10k] report=$REPORT"
bun --no-env-file scripts/persistence/graduation-ttv.ts --pages 10000 --seed 1 --live-serve --out "$REPORT" --enforce
