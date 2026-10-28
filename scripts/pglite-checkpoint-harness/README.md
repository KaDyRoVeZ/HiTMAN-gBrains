# PGLite checkpoint harness

`scripts/pglite-checkpoint-harness/supervisor.ts` reproduces the large-store
PGLite freeze. It spawns `worker.ts`, which imports 40 KB pages through
`PGLiteEngine.transaction()` into one long-lived store. It then watches that
process from outside: CPU from `/proc`, committed pages from the worker's
progress file, and WAL and checkpoint activity from the data directory. A
worker that burns CPU with no committed page and no checkpoint progress for
`--stall-sec` is reported as wedged. A completed run also asserts that WAL
since the last redo point never exceeded the guard threshold plus the largest
single transaction. `--shared-buffers` and `--max-wal-size` scale the store
down with `ALTER SYSTEM`, so a small machine reaches the same trigger in
minutes:

```bash
bun scripts/pglite-checkpoint-harness/supervisor.ts --dir /tmp/h --fresh --pages 3000 --stall-sec 600 --timeout-sec 1800
bun scripts/pglite-checkpoint-harness/supervisor.ts --dir /tmp/h --fresh --pages 1500 \
  --shared-buffers 16MB --max-wal-size 160MB --stall-sec 120 --expect-wedge   # baseline check
```

`--min-store-gb <n>` also fails a completed run whose data directory is
smaller than `n` GiB; the result reports the store size with and without WAL.
On macOS the supervisor samples worker CPU with `ps` instead of `/proc`.
