/**
 * F4a on real Postgres (and PgBouncer in the backend matrix): the migrated
 * single-statement getHealth equals the pre-F4a implementation field by field
 * on the same fixtures and scopes as the PGLite suite
 * (`test/engine-sql-health-equality.test.ts`); the SQL orphan predicate agrees
 * with the TypeScript policy under Postgres's regex engine and collation
 * (`test/orphan-policy-sql-parity.test.ts` is the PGLite twin); and the
 * get_health memo's generation read (page clock, brain id, config) works on
 * this backend, so the memo actually serves hits here instead of silently
 * falling back to uncached reads.
 *
 * DATABASE_URL gated.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import { clearHealthMemo } from '../../src/core/health-memo.ts';
import { _resetPackCacheForTests } from '../../src/core/schema-pack/registry.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { withEnv } from '../helpers/with-env.ts';
import {
  HEALTH_SRC_A,
  expectHealthMatchesLegacy,
  importE2eMarkdownFixtures,
  seedRandomHealthGraph,
  seedSourceScopeFixture,
} from '../helpers/health-equality-fixtures.ts';
import { expectOrphanPolicyParity } from '../helpers/orphan-policy-parity.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-f4a-health-pg-'));
const env = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, fn);

describe.skipIf(!hasDatabase())('F4a getHealth on Postgres', () => {
  let engine: PostgresEngine;

  beforeEach(async () => {
    engine = await setupDB();
    _resetPackCacheForTests();
    clearHealthMemo();
  }, 120_000);

  afterAll(async () => {
    await teardownDB();
    rmSync(home, { recursive: true, force: true });
  });

  test('orphan policy: SQL and TS renderers agree on the generated corpus', async () => {
    expect(await expectOrphanPolicyParity(engine)).toBeGreaterThan(2000);
  });

  test('empty brain and #4592 source-scope fixture match the pre-F4a implementation', async () => {
    await env(() => expectHealthMatchesLegacy(engine, 'pg-empty'));
    await seedSourceScopeFixture(engine);
    const [all] = await env(() => expectHealthMatchesLegacy(engine, 'pg-source-scope'));
    expect(all.page_count).toBe(3);
  });

  test('E2E markdown fixture corpus matches the pre-F4a implementation', async () => {
    expect(await importE2eMarkdownFixtures(engine)).toBeGreaterThan(10);
    await env(() => expectHealthMatchesLegacy(engine, 'pg-e2e-corpus'));
  });

  for (const seed of [1, 7, 42]) {
    test(`seeded random graph ${seed} matches the pre-F4a implementation`, async () => {
      await seedRandomHealthGraph(engine, seed);
      const [all] = await env(() => expectHealthMatchesLegacy(engine, `pg-random-${seed}`));
      expect(all.most_connected.length).toBe(5);
    });
  }

  test('seeded random graph under an active schema pack matches', async () => {
    await engine.setConfig('schema_pack', 'gbrain-base-v2');
    await seedRandomHealthGraph(engine, 99);
    await env(() => expectHealthMatchesLegacy(engine, 'pg-random-pack'));
  });

  test('the get_health memo serves hits on this backend and stays scope-confined', async () => {
    await seedSourceScopeFixture(engine);
    const op = (ctx: Partial<OperationContext>) =>
      operationsByName.get_health.handler({ engine, takesHoldersAllowList: ['world'], ...ctx } as OperationContext, {}) as Promise<{ computed_at: string; page_count: number }>;
    const trusted = { remote: false } as Partial<OperationContext>;
    const scoped = { remote: true, transport: 'http', sourceId: HEALTH_SRC_A } as Partial<OperationContext>;
    const first = await op(trusted);
    await new Promise(r => setTimeout(r, 5));
    const second = await op(trusted);
    expect(second.computed_at).toBe(first.computed_at);
    expect((await op(scoped)).page_count).toBe(2);
    expect((await op(trusted)).page_count).toBe(3);
    await engine.putPage('notes/new-page', { type: 'note', title: 'New', compiled_truth: 'new' });
    const third = await op(trusted);
    expect(third.computed_at).not.toBe(first.computed_at);
    expect(third.page_count).toBe(4);
  });
});
