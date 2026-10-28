/**
 * #5216 on Postgres: a populated brain from before migration 150 upgrades
 * through the real `initSchema` path (schema replay first, then pending
 * migrations, then the resumable revision backfill). The pages table is never
 * rewritten, every page ends with a revision, an interrupted backfill resumes
 * with concurrent reads and writes, and the final column constraints equal a
 * fresh install.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, setConfigVersion } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { resumePageRevisionBackfill } from '../../src/core/page-state/revision-backfill-schema.ts';

const RUN = hasDatabase();
const describeE2E = RUN ? describe : describe.skip;
let engine: PostgresEngine;

const flags = () => engine.executeRaw<{ notnull: boolean; def: string | null }>(
  `SELECT a.attnotnull AS notnull, pg_get_expr(d.adbin, d.adrelid) AS def FROM pg_attribute a
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = 'pages'::regclass AND a.attname = 'knowledge_revision'`);
const relfilenode = async () => Number((await engine.executeRaw<{ f: number }>("SELECT relfilenode AS f FROM pg_class WHERE relname = 'pages'"))[0]!.f);

describeE2E('page revision rollout on Postgres (#5216)', () => {
  beforeAll(async () => { engine = await setupDB(); }, 60_000);
  afterAll(async () => {
    if (engine && !(await flags())[0]?.notnull) await resumePageRevisionBackfill(engine, { log: () => {} });
    await teardownDB();
  });

  test('a populated pre-v150 brain upgrades through initSchema without a pages rewrite and ends at fresh-install constraints', async () => {
    const fresh = (await flags())[0];
    for (let i = 0; i < 25; i++) await engine.putPage(`notes/rollout-${i}`, { type: 'note', title: `Rollout ${i}`, compiled_truth: 'body '.repeat(3000) }, { sourceId: 'default' });
    await engine.executeRaw('ALTER TABLE pages DROP COLUMN knowledge_revision CASCADE');
    await setConfigVersion(149);
    const before = await relfilenode();
    await engine.initSchema();
    expect(await relfilenode()).toBe(before);
    expect((await flags())[0]).toEqual(fresh);
    const [{ missing }] = await engine.executeRaw<{ missing: number }>('SELECT count(*)::int AS missing FROM pages WHERE knowledge_revision IS NULL');
    expect(missing).toBe(0);
  }, 120_000);

  test('an interrupted backfill resumes with concurrent reads and writes and never reassigns a revision', async () => {
    await engine.executeRaw('ALTER TABLE pages ALTER COLUMN knowledge_revision DROP NOT NULL');
    await engine.executeRaw('ALTER TABLE pages DISABLE TRIGGER USER');
    await engine.executeRaw("UPDATE pages SET knowledge_revision = NULL WHERE slug LIKE 'notes/rollout-%'");
    await engine.executeRaw('ALTER TABLE pages ENABLE TRIGGER USER');
    let batches = 0;
    const dying = new Proxy(engine, { get(target, prop, receiver) {
      if (prop === 'executeRaw') return (sql: string, params?: unknown[]) => {
        if (/^SELECT id FROM pages WHERE id > \$1/.test(sql) && ++batches > 2) return Promise.reject(new Error('process killed'));
        return target.executeRaw(sql, params as never);
      };
      return Reflect.get(target, prop, receiver);
    } }) as PostgresEngine;
    await expect(resumePageRevisionBackfill(dying, { batchSize: 5, log: () => {} })).rejects.toThrow('process killed');
    const assigned = await engine.executeRaw<{ slug: string; r: string }>("SELECT slug, knowledge_revision::text AS r FROM pages WHERE knowledge_revision IS NOT NULL AND slug LIKE 'notes/rollout-%'");
    expect(assigned.length).toBe(10);

    const reads = Promise.all(Array.from({ length: 5 }, () => engine.readPageSnapshot('notes/rollout-24', { sourceId: 'default' })));
    await engine.executeRaw("UPDATE pages SET title = 'written during the pause' WHERE slug = 'notes/rollout-20'");
    const [written] = await engine.executeRaw<{ r: string }>("SELECT knowledge_revision::text AS r FROM pages WHERE slug = 'notes/rollout-20'");
    const resumed = resumePageRevisionBackfill(engine, { batchSize: 5, log: () => {} });
    for (const snapshot of await reads) expect(snapshot!.revision).not.toBe('null');
    expect((await resumed).status).toBe('complete');

    const after = Object.fromEntries((await engine.executeRaw<{ slug: string; r: string }>(
      "SELECT slug, knowledge_revision::text AS r FROM pages WHERE slug LIKE 'notes/rollout-%'")).map(row => [row.slug, row.r]));
    for (const row of assigned) expect(after[row.slug]).toBe(row.r);
    expect(after['notes/rollout-20']).toBe(written!.r);
    expect(Object.values(after).every(r => /^[0-9a-f-]{36}$/.test(r))).toBe(true);
    expect((await flags())[0]!.notnull).toBe(true);
    expect(await engine.executeRaw("SELECT conname FROM pg_constraint WHERE conname = 'pages_knowledge_revision_backfilled'")).toEqual([]);
  }, 120_000);
});
