/**
 * Engine graduation copier, end to end: a `buildHistoryFixture` PGLite brain
 * (1,000 pages by default, GRADUATION_COPY_PAGES overrides) is drained with
 * the request-only consumer, frozen, and copied table by table into fresh
 * Postgres targets, once under `session_replication_role = replica` and once
 * under the DISABLE TRIGGER fallback behind a database fence.
 *
 * Protects: verbatim copy with primary keys preserved (every carried table's
 * canonical digest from graduation-digest.ts, transforms applied to the
 * source side, equals the target's, in the inventory's copy order),
 * initSchema seed rows replaced, exact sequence positions, every FK satisfied, user triggers enabled after the copy, deferred HNSW/GIN indexes
 * rebuilt, and the fence still refusing writes that lack the run identity.
 * Fails when: a column, key, sequence position, trigger state or index set
 * differs, or the copy needs a session the fence would refuse.
 * Seams: none. Requires DATABASE_URL.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { GBrainConfig } from '../../src/core/config.ts';
import type { InventoryEntry, TriggerBypass } from '../../src/core/persistence/engine-graduation.types.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { buildHistoryFixture, HISTORY_FIXTURE_TABLES, type HistoryFixture } from '../../scripts/persistence/history-fixture.ts';
import { copySequences, deferIndexes, buildDeferredIndexes, detectTriggerBypass } from '../../src/core/persistence/graduation-copy.ts';
import { drainForGraduation, freezeSource } from '../../src/core/persistence/graduation-drain.ts';
import { embeddingColumns } from '../../src/core/persistence/graduation-target.ts';
import { copiedEntries, copyAll, digestMismatches } from '../helpers/graduation-copy-harness.ts';
import { assertRelationSet } from '../../src/core/persistence/graduation-inventory.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';

const databaseUrl = requirePostgresTestDatabase();
const PAGES = Number(process.env.GRADUATION_COPY_PAGES ?? 1000);
const priorHome = process.env.GBRAIN_HOME;
const home = mkdtempSync(join(tmpdir(), 'gbrain-graduation-copy-e2e-'));
const admin = postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} });
const databases: string[] = [];
let source: PGLiteEngine;
let fixture: HistoryFixture;
let drained: readonly string[] = [];
const timings: Record<string, number> = {};

async function freshTarget(): Promise<PostgresEngine> {
  const name = `gbrain_test_graduation_${randomUUID().replace(/-/g, '')}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  databases.push(name);
  const url = new URL(databaseUrl); url.pathname = `/${name}`;
  const engine = new PostgresEngine();
  await engine.connect({ database_url: url.toString(), poolSize: 4 });
  await engine.initSchema();
  return engine;
}

async function indexSet(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ name: string }>(`SELECT i.relname AS name FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace JOIN pg_am am ON am.oid = i.relam
    WHERE n.nspname = 'public' AND am.amname IN ('hnsw', 'gin') ORDER BY 1`);
  return rows.map(r => r.name);
}

async function fkOrphans(engine: BrainEngine): Promise<string[]> {
  const fks = await engine.executeRaw<{ name: string; child: string; parent: string; child_cols: string[]; parent_cols: string[] }>(`SELECT k.conname AS name,
      format('%I', c.relname) AS child, format('%I', p.relname) AS parent,
      ARRAY(SELECT format('%I', a.attname) FROM unnest(k.conkey) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.o) AS child_cols,
      ARRAY(SELECT format('%I', a.attname) FROM unnest(k.confkey) WITH ORDINALITY u(n, o) JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n ORDER BY u.o) AS parent_cols
    FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid JOIN pg_class p ON p.oid = k.confrelid JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE k.contype = 'f' AND n.nspname = 'public'`);
  const orphans: string[] = [];
  for (const fk of fks) {
    const [row] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${fk.child} c WHERE ${fk.child_cols.map(col => `c.${col} IS NOT NULL`).join(' AND ')}
      AND NOT EXISTS (SELECT 1 FROM ${fk.parent} p WHERE ${fk.child_cols.map((col, i) => `p.${fk.parent_cols[i]} = c.${col}`).join(' AND ')})`);
    if (Number(row!.n) > 0) orphans.push(`${fk.name}: ${row!.n}`);
  }
  return orphans;
}

async function installTestFence(target: BrainEngine, runId: string): Promise<void> {
  await target.executeRaw(`CREATE OR REPLACE FUNCTION test_graduation_fence() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF current_setting('gbrain.graduation_run', true) IS DISTINCT FROM '${runId}' THEN
        RAISE EXCEPTION 'graduation_in_progress';
      END IF;
      RETURN NULL;
    END $$`);
  const tables = await target.executeRaw<{ ident: string }>(`SELECT format('%I', c.relname) AS ident FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'`);
  for (const t of tables) {
    await target.executeRaw(`CREATE TRIGGER gbrain_graduation_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${t.ident}
      FOR EACH STATEMENT EXECUTE FUNCTION test_graduation_fence()`);
    await target.executeRaw(`ALTER TABLE ${t.ident} ENABLE ALWAYS TRIGGER gbrain_graduation_fence`);
  }
}

async function graduateInto(target: PostgresEngine, bypass: TriggerBypass, runId: string, label: string): Promise<InventoryEntry[]> {
  const e = { source, target };
  const entries = [...await copiedEntries(e)];
  const before = await indexSet(target);
  let t = performance.now();
  const deferred = await deferIndexes(target, { runId });
  expect(deferred.length).toBeGreaterThan(0);
  expect(await indexSet(target)).toEqual([]);
  timings[`${label}.defer_ms`] = Math.round(performance.now() - t);
  t = performance.now();
  const counts = await copyAll(e, entries, { bypass, runId, batchBytes: 256 * 1024 });
  timings[`${label}.copy_ms`] = Math.round(performance.now() - t);
  t = performance.now();
  const positions = await copySequences(e, { runId });
  timings[`${label}.sequences_ms`] = Math.round(performance.now() - t);
  t = performance.now();
  await buildDeferredIndexes(target, { runId, log: () => {} });
  timings[`${label}.indexes_ms`] = Math.round(performance.now() - t);
  expect(await indexSet(target)).toEqual(before);
  expect(positions.length).toBeGreaterThan(40);
  for (const table of HISTORY_FIXTURE_TABLES) expect({ table, copied: (counts[table] ?? 0) > 0 }).toEqual({ table, copied: true });
  return entries;
}

async function assertEqualCopy(target: PostgresEngine, entries: readonly InventoryEntry[]): Promise<void> {
  expect(await digestMismatches({ source, target }, entries)).toEqual([]);
  expect(await fkOrphans(target)).toEqual([]);
  const disabled = await target.executeRaw(`SELECT tgrelid::regclass::text AS relation, tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'D'`);
  expect(disabled).toEqual([]);
  const sequences = await source.executeRaw<{ name: string }>(`SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'S'`);
  for (const { name } of sequences) {
    const [present] = await target.executeRaw<{ present: boolean }>("SELECT to_regclass(format('public.%I', $1::text)) IS NOT NULL AS present", [name]);
    if (!present!.present) continue;
    const [s] = await source.executeRaw<{ v: string; c: boolean }>(`SELECT last_value::text AS v, is_called AS c FROM ${name}`);
    const [t] = await target.executeRaw<{ v: string; c: boolean }>(`SELECT last_value::text AS v, is_called AS c FROM ${name}`);
    const next = (r: { v: string; c: boolean }) => BigInt(r.v) + (r.c ? 1n : 0n);
    expect({ name, ok: next(t!) >= next(s!) }).toEqual({ name, ok: true });
  }
}

beforeAll(async () => {
  process.env.GBRAIN_HOME = home;
  source = new PGLiteEngine();
  await source.connect({});
  await source.initSchema();
  const t = performance.now();
  fixture = await buildHistoryFixture(source, { pages: PAGES, seed: 7, sources: 3, worktrees: 2, root: join(home, 'checkouts') });
  timings.fixture_ms = Math.round(performance.now() - t);
  const d = performance.now();
  const result = await drainForGraduation(source, { timeoutMs: 60_000, hostId: localHostId(), config: { engine: 'pglite', embedding_disabled: true } as GBrainConfig });
  timings.drain_ms = Math.round(performance.now() - d);
  expect(result.blockers).toEqual([]);
  drained = result.drained;
  await freezeSource(source);
  await assertRelationSet(source, 'pglite');
}, 1_800_000);

afterAll(async () => {
  process.stderr.write(`[graduation-copy e2e] pages=${PAGES} ${JSON.stringify(timings)}\n`);
  await source?.disconnect();
  for (const name of databases) await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
  await admin.end();
  if (priorHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = priorHome;
  rmSync(home, { recursive: true, force: true });
}, 120_000);

describe(`graduation copy of a ${PAGES}-page history brain`, () => {
  test('the pending request drained before the copy', () => {
    expect(drained).toContain(fixture.queuedRequestId);
  });

  test('replica mode: every carried table round-trips with keys, sequences, FKs, triggers and indexes intact', async () => {
    const target = await freshTarget();
    try {
      expect(await embeddingColumns((sql, p) => target.executeRaw(sql, p))).toEqual(await embeddingColumns((sql, p) => source.executeRaw(sql, p)));
      expect(await detectTriggerBypass(target)).toBe('session_replication_role');
      await assertRelationSet(target, 'postgres');
      const entries = await graduateInto(target, 'session_replication_role', randomUUID(), 'replica');
      await assertEqualCopy(target, entries);
      const [brain] = await target.executeRaw<{ brain_id: string; enabled: boolean }>('SELECT brain_id::text AS brain_id, enabled FROM persistence_brain');
      const [sourceBrain] = await source.executeRaw<{ brain_id: string }>('SELECT brain_id::text AS brain_id FROM persistence_brain');
      expect(brain).toEqual({ brain_id: sourceBrain!.brain_id, enabled: false });
      const delayedSql = "SELECT state, to_char(next_attempt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS at FROM persistence_effects WHERE id = $1";
      const [delayed] = await target.executeRaw<{ state: string; at: string }>(delayedSql, [fixture.delayedEffectId]);
      const [sourceDelayed] = await source.executeRaw<{ state: string; at: string }>(delayedSql, [fixture.delayedEffectId]);
      expect(delayed).toEqual({ state: 'queued', at: sourceDelayed!.at });
    } finally { await target.disconnect(); }
  }, 900_000);

  test('DISABLE TRIGGER fallback behind a fence: same copy, fence stays on for everyone else', async () => {
    const target = await freshTarget();
    const runId = randomUUID();
    try {
      await installTestFence(target, runId);
      await expect(target.executeRaw("UPDATE config SET value = value WHERE key = 'version'")).rejects.toThrow(/graduation_in_progress/);
      const entries = await graduateInto(target, 'disable_trigger', runId, 'disable_trigger');
      await assertEqualCopy(target, entries);
      const fences = await target.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'gbrain_graduation_fence' AND tgenabled = 'A'`);
      expect(Number(fences[0]!.n)).toBeGreaterThan(90);
      await expect(target.executeRaw("DELETE FROM pages WHERE false")).rejects.toThrow(/graduation_in_progress/);
    } finally { await target.disconnect(); }
  }, 900_000);
});
