#!/usr/bin/env bash
# scripts/bench/retrieval-scale/vm-setup.sh — bootstrap one Ubicloud VM for the
# retrieval scale bench (GBRA-156): Docker, bun, frozen dependencies and a
# pgvector/pgvector:pg16 server on 127.0.0.1:5434 sized to the VM (via
# hnsw-scale-vm-setup.sh), then PgBouncer in transaction mode on 127.0.0.1:6543
# in front of it, the pooled topology large hosted brains run behind.
#
#   scripts/ubicloud/ubi-runner.sh ssh "$name" 'cd work/gbrain && bash scripts/bench/retrieval-scale/vm-setup.sh'
#   bun scripts/bench/retrieval-scale/corpus.ts --url postgresql://postgres:postgres@127.0.0.1:5434/postgres --db bench_retrieval_300k --pages 300000 --workers 16
#   bun scripts/bench/retrieval-scale/run.ts --manifest manifest.json --url 'postgresql://postgres:postgres@127.0.0.1:6543/bench_retrieval_300k?prepare=false' --direct-url postgresql://postgres:postgres@127.0.0.1:5434/bench_retrieval_300k --trace
set -euo pipefail
bash "$(dirname "$0")/../hnsw-scale-vm-setup.sh"
sudo docker rm -f retrieval-bench-bouncer >/dev/null 2>&1 || true
sudo docker run -d --name retrieval-bench-bouncer --network host \
  -e DB_HOST=127.0.0.1 -e DB_PORT=5434 -e DB_USER=postgres -e DB_PASSWORD=postgres \
  -e LISTEN_ADDR=127.0.0.1 -e LISTEN_PORT=6543 -e POOL_MODE=transaction -e AUTH_TYPE=plain \
  -e MAX_CLIENT_CONN=500 -e DEFAULT_POOL_SIZE=20 \
  -e IGNORE_STARTUP_PARAMETERS=extra_float_digits,statement_timeout,idle_in_transaction_session_timeout,search_path \
  edoburu/pgbouncer:latest >/dev/null
for _ in $(seq 1 30); do
  PGPASSWORD=postgres psql -h 127.0.0.1 -p 6543 -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1 && break
  sleep 1
done
PGPASSWORD=postgres psql -h 127.0.0.1 -p 6543 -U postgres -d postgres -tAc "select 'pgbouncer ok'"
# Toxiproxy on 127.0.0.1:6544 -> PgBouncer, so run.ts --rtt-ms can model a pooler across a network.
sudo docker rm -f retrieval-bench-toxiproxy >/dev/null 2>&1 || true
sudo docker run -d --name retrieval-bench-toxiproxy --network host ghcr.io/shopify/toxiproxy:2.9.0 >/dev/null
for _ in $(seq 1 30); do curl -fsS http://127.0.0.1:8474/version >/dev/null 2>&1 && break; sleep 1; done
curl -fsS -XPOST http://127.0.0.1:8474/proxies -d '{"name":"pooler","listen":"127.0.0.1:6544","upstream":"127.0.0.1:6543"}' >/dev/null
echo "toxiproxy ok"
