/**
 * Engine graduation copier (`src/core/persistence/graduation-copy.ts`).
 *
 * Protects: the per-column contract (missing, retyped, extra and differently
 * generated columns refuse unless allowlisted; generated columns are never
 * inserted), verbatim copy under both trigger-bypass mechanisms (seed rows
 * replaced inside the copy transaction, target-owned config keys kept, text
 * keys ordered with COLLATE "C" across tiny byte-sized batches, every value
 * type round-tripping through canonical text, self-FK forward references,
 * lease and claim transforms), exact sequence positions including values
 * consumed by aborted transactions, the database fence staying enforced
 * during a DISABLE TRIGGER copy, deferred HNSW/GIN indexes and their
 * crash-durable pending row, and trigger re-enabling.
 * Fails when: any copied value, key or sequence position differs, a fence is
 * disabled, a seed row survives, or an index is lost.
 * Seams: none; PGLite source always, PGLite target always, Postgres target
 * when DATABASE_URL is set.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ColumnMeta, TriggerBypass } from '../src/core/persistence/engine-graduation.types.ts';
import {
  buildDeferredIndexes, columnContract, copySequences, copyTable, deferIndexes, detectTriggerBypass, GRADUATION_DEFERRED_INDEXES_KEY, recopyClosure, reenableTriggers,
} from '../src/core/persistence/graduation-copy.ts';
import { tableColumns } from '../src/core/persistence/graduation-digest.ts';
import { fkClosure, GRADUATION_INVENTORY } from '../src/core/persistence/graduation-inventory.ts';
import { digestMismatches, inventoryEntry as entry, rowCount } from './helpers/graduation-copy-harness.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const col = (name: string, type: string, extra: Partial<ColumnMeta> = {}): ColumnMeta =>
  ({ name, type, category: type === 'text' ? 'S' : 'N', generated: false, collatable: type === 'text', ...extra });
const side = (columns: ColumnMeta[], generated: Record<string, string> = {}) => ({ columns, generated: new Map(Object.entries(generated)) });

describe('column contract', () => {
  test('copies matching columns and never inserts generated ones', () => {
    const source = side([col('id', 'integer'), col('a', 'text'), col('n', 'integer', { generated: true })], { n: 'length(a)' });
    const target = side([col('a', 'text'), col('id', 'integer'), col('n', 'integer', { generated: true })], { n: 'length(a)' });
    expect(columnContract(entry('t'), source, target)).toEqual(['id', 'a']);
  });

  test('refuses missing, retyped, target-only and differently generated columns, naming each', () => {
    const source = side([col('id', 'integer'), col('a', 'text'), col('emb', 'vector(1536)'), col('n', 'integer', { generated: true })], { n: 'length(a)' });
    const target = side([col('id', 'integer'), col('emb', 'vector(768)'), col('extra', 'text'), col('n', 'integer', { generated: true })], { n: '(length(a) + 1)' });
    let error: unknown;
    try { columnContract(entry('t'), source, target); } catch (e) { error = e; }
    const json = (error as { toJSON(): Record<string, unknown> }).toJSON();
    expect(json.code).toBe('graduation_target_unsupported');
    expect(String(json.detail)).toContain('a (text) is missing on the target');
    expect(String(json.detail)).toContain('emb is vector(1536) on the source but vector(768) on the target');
    expect(String(json.detail)).toContain('extra (text) exists only on the target');
    expect(String(json.detail)).toContain('n generation differs');
    expect((json.fix as { argv: string[] }).argv).toContain('--plan');
  });

  test('an allowlisted column may differ', () => {
    const source = side([col('id', 'integer'), col('legacy', 'text')]);
    const target = side([col('id', 'integer'), col('added', 'text')]);
    expect(columnContract(entry('t', { columnAllowlist: { legacy: 'dropped upstream', added: 'nullable, defaulted' } }), source, target)).toEqual(['id']);
  });

  test('every inventory transform carries the SQL the copier selects', () => {
    const transforms = GRADUATION_INVENTORY.entries.flatMap(e => e.transforms.map(t => ({ relation: e.relation, ...t })));
    expect(transforms.length).toBeGreaterThan(0);
    expect(transforms.filter(t => !t.expression)).toEqual([]);
  });
});

const TYPES_TABLE = `CREATE TABLE graduation_test_types (
  k text PRIMARY KEY, n numeric, f double precision, r real, ts timestamptz, d date, arr text[], ints integer[], j jsonb, b bytea,
  tsv tsvector, v vector(3), h halfvec(3), payload text, len integer GENERATED ALWAYS AS (length(payload)) STORED)`;

async function seedSource(source: BrainEngine): Promise<void> {
  await source.executeRaw(TYPES_TABLE);
  await source.transaction(async tx => {
    await tx.executeRaw('SET LOCAL session_replication_role = replica');
    for (const [i, key] of ['Zeta', 'alpha', 'a-b', 'a_b', 'é', 'B', 'b', '1'].entries()) {
      await tx.executeRaw(`INSERT INTO graduation_test_types (k, n, f, r, ts, d, arr, ints, j, b, tsv, v, h, payload) VALUES
        ($1, 12345678901234567890.0123456789, 0.1 + 0.2, 1.1, '2026-03-08 01:59:59.123456-08', '2028-02-29'::date - $6::int, ARRAY['x', NULL, 'quote"d', 'back\\slash'],
         ARRAY[1, -2, NULL], $2::text::jsonb, decode($3, 'hex'), to_tsvector('simple', $4), '[1.5,-2.25,3]', '[0.5,1,2]', $5)`,
        [key, `{"big": 12345678901234567890.5, "nested": {"s": "\u00fc\\n", "i": ${i}}}`, 'deadbeef00ff', `word${i} other`, 'x'.repeat(i === 3 ? 300_000 : i * 10), i]);
    }
    await tx.executeRaw("INSERT INTO sources (id, name, local_path) VALUES ('history-a', 'History A', '/tmp/a'), ('History-B', 'History B', NULL)");
    await tx.executeRaw("UPDATE sources SET name = 'renamed default' WHERE id = 'default'");
    await tx.executeRaw("INSERT INTO facts (id, fact, source, superseded_by) VALUES (1, 'old', 'test', 3), (2, 'other', 'test', NULL), (3, 'new', 'test', NULL)");
    await tx.executeRaw("SELECT setval('facts_id_seq', 3, true)");
    for (let i = 0; i < 4; i++) await tx.executeRaw("SELECT nextval('facts_id_seq')");
    await tx.executeRaw(`INSERT INTO minion_jobs (id, name, status, claim_generation, lock_token, lock_until, started_at, timeout_at)
      VALUES (1, 'active-job', 'active', 3, 'tok', now() + interval '1 hour', now(), now() + interval '1 hour'),
             (2, 'done-job', 'completed', 1, NULL, NULL, now(), NULL)`);
    await tx.executeRaw("SELECT setval('minion_jobs_id_seq', 2, true)");
    await tx.executeRaw("INSERT INTO config (key, value) VALUES ('source.only', 'carried'), ('Zz.case', 'kept') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  });
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`PGLite -> ${backend} copyTable`, () => {
    let source: BrainEngine; let target: BrainEngine;
    const closers: Array<() => Promise<void>> = [];
    beforeEach(async () => {
      const s = await isolatedSharedSkillsEngine(); const t = await isolatedSharedSkillsEngine(databaseUrl);
      source = s.engine; target = t.engine; closers.push(s.close, t.close);
      await seedSource(source);
      await target.executeRaw(TYPES_TABLE);
      await target.executeRaw("INSERT INTO config (key, value) VALUES ('target.extra', 'dropped') ON CONFLICT (key) DO NOTHING");
    }, 120_000);
    afterEach(async () => { for (const close of closers.splice(0)) await close(); });

    for (const bypass of ['session_replication_role', 'disable_trigger'] as TriggerBypass[]) {
      test(`${bypass}: verbatim copy, seed rows replaced, owned config kept, transforms, self-FK, exact sequences`, async () => {
        const e = { source, target };
        const runId = randomUUID();
        const [targetVersion] = await target.executeRaw<{ value: string }>("SELECT value FROM config WHERE key = 'version'");
        const relations = ['config', 'sources', 'graduation_test_types', 'facts', 'minion_jobs'];
        const batches: number[] = [];
        for (const relation of relations) {
          const { rows } = await copyTable(e, entry(relation), { bypass, runId, batchBytes: 64, onBatch: n => { batches.push(n); } });
          expect(rows).toBe(await rowCount(source, entry(relation)));
        }
        expect(Math.max(...batches)).toBeLessThan(10);
        expect(await digestMismatches(e, relations.map(r => entry(r)))).toEqual([]);
        const keys = (await target.executeRaw<{ k: string }>('SELECT k FROM graduation_test_types ORDER BY k COLLATE "C"')).map(r => r.k);
        expect(keys).toEqual(['1', 'B', 'Zeta', 'a-b', 'a_b', 'alpha', 'b', 'é']);
        expect(await target.executeRaw("SELECT id FROM sources WHERE id = 'default' AND name = 'renamed default'")).toHaveLength(1);
        expect(await target.executeRaw("SELECT value FROM config WHERE key = 'version'")).toEqual([targetVersion]);
        expect(await target.executeRaw("SELECT 1 FROM config WHERE key = 'target.extra'")).toHaveLength(0);
        expect(await target.executeRaw("SELECT value FROM config WHERE key = 'source.only'")).toEqual([{ value: 'carried' }]);
        expect(await target.executeRaw('SELECT len FROM graduation_test_types WHERE k = $1', ['a_b'])).toEqual([{ len: 300_000 }]);
        expect(await target.executeRaw('SELECT superseded_by::int AS superseded_by FROM facts WHERE id = 1')).toEqual([{ superseded_by: 3 }]);
        expect(await target.executeRaw(`SELECT status, claim_generation::int AS claim_generation, lock_token, lock_until, started_at, timeout_at FROM minion_jobs WHERE id = 1`))
          .toEqual([{ status: 'waiting', claim_generation: 3, lock_token: null, lock_until: null, started_at: null, timeout_at: null }]);
        expect(await target.executeRaw("SELECT status FROM minion_jobs WHERE id = 2 AND started_at IS NOT NULL")).toEqual([{ status: 'completed' }]);

        const positions = await copySequences(e, { runId });
        expect(positions.find(p => p.sequence === 'facts_id_seq')).toEqual({ sequence: 'facts_id_seq', value: '7', isCalled: true, raisedToColumnMax: false });
        const [next] = await target.executeRaw<{ id: number }>("SELECT nextval('facts_id_seq')::int AS id");
        expect(next!.id).toBe(8);
        const [seedSeq] = await source.executeRaw<{ v: string; c: boolean }>('SELECT last_value::text AS v, is_called AS c FROM shared_skill_delivery_batches_id_seq').catch(() => [{ v: '1', c: false }]);
        if (positions.some(p => p.sequence === 'shared_skill_delivery_batches_id_seq')) {
          expect(positions.find(p => p.sequence === 'shared_skill_delivery_batches_id_seq')).toMatchObject({ value: seedSeq!.v, isCalled: seedSeq!.c });
        }
        const disabled = await target.executeRaw("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'D'");
        expect(disabled).toEqual([]);
      }, 120_000);
    }

    for (const bypass of ['session_replication_role', 'disable_trigger'] as TriggerBypass[]) {
      test(`${bypass}: a changed table is re-copied with its whole FK closure`, async () => {
        const e = { source, target };
        const first = await recopyClosure(e, 'sources', { bypass, runId: 'r' });
        const closure = (await fkClosure(target, 'sources')).filter(name => name in first);
        expect(Object.keys(first)).toEqual(closure);
        expect(closure).toEqual(expect.arrayContaining(['sources', 'pages', 'facts']));
        expect(closure.indexOf('sources')).toBeLessThan(closure.indexOf('pages'));
        await source.transaction(async tx => {
          await tx.executeRaw('SET LOCAL session_replication_role = replica');
          await tx.executeRaw("UPDATE sources SET name = 'renamed again' WHERE id = 'history-a'");
          await tx.executeRaw("INSERT INTO facts (id, fact, source, source_id, superseded_by) VALUES (9, 'later', 'test', 'history-a', 2)");
        });
        const second = await recopyClosure(e, 'sources', { bypass, runId: 'r' });
        expect(second.facts).toBe(4);
        expect(await digestMismatches(e, closure.map(name => entry(name)))).toEqual([]);
        expect(await target.executeRaw("SELECT tgname FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'D'")).toEqual([]);
      }, 120_000);
    }

    test('a sequence behind the target column maximum is raised to it', async () => {
      const e = { source, target };
      await copyTable(e, entry('facts'), { bypass: 'session_replication_role', runId: 'r' });
      await target.transaction(async tx => {
        await tx.executeRaw('SET LOCAL session_replication_role = replica');
        await tx.executeRaw("INSERT INTO facts (id, fact, source) VALUES (40, 'target-side', 'test')");
      });
      expect((await copySequences(e)).find(p => p.sequence === 'facts_id_seq')).toEqual({ sequence: 'facts_id_seq', value: '40', isCalled: true, raisedToColumnMax: true });
    }, 60_000);

    test('a DISABLE TRIGGER copy keeps the ENABLE ALWAYS fence on and passes it with the run identity', async () => {
      const runId = randomUUID();
      await target.executeRaw(`CREATE OR REPLACE FUNCTION test_graduation_fence() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF current_setting('gbrain.graduation_run', true) IS DISTINCT FROM '${runId}' THEN RAISE EXCEPTION 'graduation_in_progress'; END IF; RETURN NULL; END $$`);
      for (const t of ['facts', 'config']) {
        await target.executeRaw(`CREATE TRIGGER gbrain_graduation_fence BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON ${t} FOR EACH STATEMENT EXECUTE FUNCTION test_graduation_fence()`);
        await target.executeRaw(`ALTER TABLE ${t} ENABLE ALWAYS TRIGGER gbrain_graduation_fence`);
      }
      const e = { source, target };
      await expect(copyTable(e, entry('facts'), { bypass: 'disable_trigger', runId: 'another-run' })).rejects.toThrow(/graduation_in_progress/);
      expect((await copyTable(e, entry('facts'), { bypass: 'disable_trigger', runId })).rows).toBe(3);
      expect((await copyTable(e, entry('facts'), { bypass: 'session_replication_role', runId })).rows).toBe(3);
      await expect(target.executeRaw("DELETE FROM facts WHERE id = 2")).rejects.toThrow(/graduation_in_progress/);
      expect(await target.executeRaw("SELECT tgenabled::text AS mode FROM pg_trigger WHERE tgname = 'gbrain_graduation_fence' AND tgrelid = 'facts'::regclass")).toEqual([{ mode: 'A' }]);
      await deferIndexes(target, { runId });
      expect(await target.executeRaw('SELECT 1 FROM config WHERE key = $1', [GRADUATION_DEFERRED_INDEXES_KEY])).toHaveLength(1);
    }, 60_000);

    test('column contract refuses a reshaped target table, and the allowlist admits it', async () => {
      await target.executeRaw('ALTER TABLE graduation_test_types ADD COLUMN target_only text');
      const e = { source, target };
      await expect(copyTable(e, entry('graduation_test_types'), { bypass: 'session_replication_role', runId: 'r' })).rejects.toThrow(/do not match the source/);
      const { rows } = await copyTable(e, entry('graduation_test_types', { columnAllowlist: { target_only: 'test' } }), { bypass: 'session_replication_role', runId: 'r' });
      expect(rows).toBe(8);
    }, 60_000);

    test('deferred HNSW and GIN indexes: dropped, recorded in a target-owned row that survives the config copy, rebuilt', async () => {
      const indexes = async () => (await target.executeRaw<{ name: string }>(`SELECT i.relname AS name FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
        JOIN pg_am am ON am.oid = i.relam JOIN pg_class t ON t.oid = x.indrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public' AND am.amname IN ('hnsw', 'gin') ORDER BY 1`)).map(r => r.name);
      const before = await indexes();
      expect(before).toEqual(expect.arrayContaining(['idx_chunks_embedding', 'idx_pages_search', 'idx_facts_embedding_hnsw']));
      const deferred = await deferIndexes(target, { runId: 'r' });
      expect(deferred.map(d => d.name).sort()).toEqual(before);
      expect(await indexes()).toEqual([]);
      expect((await deferIndexes(target, { runId: 'r' })).map(d => d.name).sort()).toEqual(before);
      await copyTable({ source, target }, entry('config'), { bypass: 'session_replication_role', runId: 'r' });
      expect(await target.executeRaw('SELECT 1 FROM config WHERE key = $1', [GRADUATION_DEFERRED_INDEXES_KEY])).toHaveLength(1);
      const { built } = await buildDeferredIndexes(target, { runId: 'r', log: () => {} });
      expect([...built].sort()).toEqual(before);
      expect(await indexes()).toEqual(before);
      expect(await target.executeRaw('SELECT 1 FROM config WHERE key = $1', [GRADUATION_DEFERRED_INDEXES_KEY])).toHaveLength(0);
    }, 120_000);

    test('trigger bypass detection and re-enabling', async () => {
      expect(await detectTriggerBypass(target)).toBe('session_replication_role');
      await target.executeRaw('ALTER TABLE facts DISABLE TRIGGER facts_preserve_withdrawal');
      expect(await reenableTriggers(target, ['facts', 'not_a_table'])).toEqual(['facts.facts_preserve_withdrawal']);
      expect(await target.executeRaw("SELECT tgenabled::text AS mode FROM pg_trigger WHERE tgname = 'facts_preserve_withdrawal'")).toEqual([{ mode: 'O' }]);
      expect((await tableColumns(target, 'graduation_test_types')).find(c => c.name === 'len')).toMatchObject({ generated: true });
    }, 60_000);
  });
}
