/**
 * F4a: get_health moved into one aggregate statement (`engine-sql/health.ts`)
 * with the orphan policy rendered in SQL. Contract protected: every
 * `BrainHealth` field equals the pre-F4a implementation (kept verbatim as
 * `test/helpers/legacy-get-health.ts`) for every scope shape, on the existing
 * fixtures (the E2E markdown corpus, the #4592 source-scope seed) and on
 * seeded random graphs that hit every orphan-policy rule, quarantine,
 * soft-delete, self-links, cross-source links, embed_skip and pack-graded
 * timeline types. A regression in any predicate (scope, liveness, policy,
 * grading, degree) changes a field and fails here. The Postgres twin is
 * `test/e2e/engine-sql-health-parity.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import {
  HEALTH_SRC_A,
  expectHealthMatchesLegacy,
  importE2eMarkdownFixtures,
  seedRandomHealthGraph,
  seedSourceScopeFixture,
} from './helpers/health-equality-fixtures.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-f4a-health-'));
const env = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, fn);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetPackCacheForTests();
});

describe('F4a getHealth equals the pre-F4a implementation field by field (PGLite)', () => {
  test('empty brain', async () => {
    const [all] = await env(() => expectHealthMatchesLegacy(engine, 'empty'));
    expect(all.brain_score).toBe(100);
  });

  test('#4592 source-scope fixture', async () => {
    await seedSourceScopeFixture(engine);
    const [all] = await env(() => expectHealthMatchesLegacy(engine, 'source-scope'));
    expect(all.page_count).toBe(3);
  });

  test('E2E markdown fixture corpus', async () => {
    const files = await importE2eMarkdownFixtures(engine);
    expect(files).toBeGreaterThan(10);
    const [all] = await env(() => expectHealthMatchesLegacy(engine, 'e2e-corpus'));
    expect(all.page_count).toBeGreaterThan(10);
  });

  for (const seed of [1, 7, 42]) {
    test(`seeded random graph ${seed}`, async () => {
      await seedRandomHealthGraph(engine, seed);
      const [all] = await env(() => expectHealthMatchesLegacy(engine, `random-${seed}`));
      expect(all.linkable_page_count).toBeGreaterThan(0);
      expect(all.linkable_page_count).toBeLessThan(all.page_count);
      expect(all.orphan_pages).toBeGreaterThan(0);
      expect(all.most_connected.length).toBe(5);
    });
  }

  test('seeded random graph under an active schema pack (pack-graded timeline types)', async () => {
    await engine.setConfig('schema_pack', 'gbrain-base-v2');
    await seedRandomHealthGraph(engine, 99);
    await env(() => expectHealthMatchesLegacy(engine, 'random-pack'));
  });

  test('a duplicated source id in a grant counts once (stale_pages included)', async () => {
    await seedSourceScopeFixture(engine);
    const once = await env(() => engine.getHealth({ sourceIds: [HEALTH_SRC_A] }));
    expect(once.stale_pages).toBeGreaterThan(0);
    expect(await env(() => engine.getHealth({ sourceIds: [HEALTH_SRC_A, HEALTH_SRC_A] }))).toEqual(once);
  });

  // PGLite has no autovacuum: a brain can be read before its first ANALYZE.
  // The pre-F4a statements (and a join-based rewrite) planned nested loops
  // that re-scan a whole relation per row there: 40 s scoped on 8,000 pages.
  // The migrated statements stay linear (about 0.15 s on the same brain).
  test('stays linear on a brain without planner statistics (8,000 pages, scoped and unscoped)', async () => {
    const n = 8000;
    await engine.executeRaw(`INSERT INTO pages (slug, type, title, compiled_truth, source_id)
      SELECT CASE WHEN g % 10 = 0 THEN 'daily/d-' || g WHEN g % 7 = 0 THEN 'people/p-' || g ELSE 'notes/n-' || g END,
             (ARRAY['person', 'company', 'note', 'concept', 'meeting', 'atom'])[1 + g % 6], 'Page ' || g, 'body', 'default'
        FROM generate_series(1, ${n}) g`);
    await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type)
      SELECT b.lo + (g::bigint * 7919) % ${n}, b.lo + (g::bigint * 104729) % ${n}, 'fixture'
        FROM generate_series(1, ${n * 2}) g, (SELECT min(id) AS lo FROM pages) b
      ON CONFLICT DO NOTHING`);
    await engine.executeRaw(`INSERT INTO timeline_entries (page_id, date, summary) SELECT id, '2026-01-01', 'event ' || id FROM pages WHERE id % 3 = 0`);
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text) SELECT id, 0, 'chunk' FROM pages`);
    for (const scope of [undefined, { sourceIds: ['default'] }]) {
      const started = performance.now();
      const health = await env(() => engine.getHealth(scope));
      expect(health.page_count).toBe(n);
      expect(performance.now() - started).toBeLessThan(5000);
    }
  }, 60_000);
});
