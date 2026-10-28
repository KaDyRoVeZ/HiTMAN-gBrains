/**
 * #5893: `bootstrap harness` rotation carries the replaced token's grants.
 *
 * Protects: the production harness mint (`mintHarnessToken`, the default
 * `deps.mint`) reads the previous token's stored `permissions` and mints the
 * replacement with the same takes holders and source grant, explicit empty
 * lists included, and with its operation snapshot narrowed (never widened) to
 * this run's snapshot. Regression it catches: the pre-fix mint hardcoding
 * `takes_holders: ['world']` and re-snapshotting operations, which silently
 * undid `auth rescope-token` / `auth permissions set-takes-holders` edits.
 * Serial: GBRAIN_HOME is remapped so the mint opens this sandboxed PGLite brain.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { mintHarnessToken } from '../src/core/bootstrap/harness.ts';
import { carryLegacyGrant, mintLegacyToken } from '../src/core/token-mint.ts';
import { executeRawJsonb } from '../src/core/sql-query.ts';
import { withEnv } from './helpers/with-env.ts';

let root: string, home: string, db: string;

async function withBrain<T>(run: (engine: BrainEngine) => Promise<T>): Promise<T> {
  const config = { engine: 'pglite' as const, database_path: db };
  const engine = await createEngine(config);
  await engine.connect(config);
  try { return await run(engine); } finally { await engine.disconnect(); }
}

const permissionsOf = (id: string) => withBrain(async engine => (await engine.executeRaw<{ permissions: Record<string, unknown> }>(
  'SELECT permissions FROM access_tokens WHERE id = $1::uuid', [id]))[0].permissions);

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'gb-harness-rotation-'));
  home = join(root, 'home');
  db = join(root, 'db');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: db }));
  await withBrain(engine => engine.initSchema());
}, 120_000);

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

const env = () => ({ GBRAIN_HOME: home, HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined });

test('rotation preserves explicit empty lists and operator-set holders', async () => {
  const snapshot = ['get_page', 'query', 'search'];
  const prior = await withBrain(async engine => {
    const minted = await mintLegacyToken(engine, { name: 'bootstrap-harness', takesHolders: ['world'], scopes: ['read', 'write'], allowedOperations: snapshot });
    await executeRawJsonb(engine, 'UPDATE access_tokens SET permissions = $2::jsonb WHERE id = $1::uuid', [minted.id],
      [{ takes_holders: [], source_id: [], allowed_operations: [], note: 'kept only on the old row' }]);
    return minted;
  });
  const rotated = await withEnv(env(), () => mintHarnessToken({ name: 'bootstrap-harness', scopes: ['read', 'write'],
    allowedOperations: snapshot, carry: { fromId: prior.id, explicitSource: false, policyAdded: [] } }));
  expect(rotated.id).not.toBe(prior.id);
  expect(await permissionsOf(rotated.id)).toEqual({ takes_holders: [], source_id: [], allowed_operations: [] });
}, 120_000);

test('rotation narrows to this run and withholds new operations instead of widening', async () => {
  const prior = await withBrain(async engine => {
    const minted = await mintLegacyToken(engine, { name: 'bootstrap-harness', takesHolders: ['world'], scopes: ['read', 'write'], allowedOperations: ['get_page', 'search'] });
    await executeRawJsonb(engine, 'UPDATE access_tokens SET permissions = $2::jsonb WHERE id = $1::uuid', [minted.id],
      [{ takes_holders: ['world', 'brain'], source_id: ['default'], allowed_operations: ['get_page', 'search'] }]);
    return minted;
  });
  const rotated = await withEnv(env(), () => mintHarnessToken({ name: 'bootstrap-harness', scopes: ['read', 'write'],
    allowedOperations: ['get_page', 'query'], carry: { fromId: prior.id, explicitSource: false, policyAdded: [] } }));
  expect(await permissionsOf(rotated.id)).toEqual({ takes_holders: ['world', 'brain'], source_id: ['default'], allowed_operations: ['get_page'] });
  expect(rotated.withheldOperations).toEqual(['query']);
}, 120_000);

test('carry rules: an explicit --source wins; policy changes add only their own operations; absent snapshot re-snapshots', () => {
  const fresh = { sourceGrant: ['wiki'], explicitSource: true, allowedOperations: ['get_page', 'join_brain'], policyAdded: ['join_brain'] };
  expect(carryLegacyGrant({ source_id: [], takes_holders: ['world'], allowed_operations: ['get_page'] }, fresh))
    .toEqual({ takesHolders: ['world'], sourceGrant: ['wiki'], allowedOperations: ['get_page', 'join_brain'], withheldOperations: [] });
  expect(carryLegacyGrant({ source_id: 'team-a' }, { ...fresh, explicitSource: false }))
    .toEqual({ takesHolders: ['world'], sourceGrant: ['team-a'], allowedOperations: ['get_page', 'join_brain'], withheldOperations: [] });
  expect(carryLegacyGrant({ allowed_operations: [] }, { ...fresh, explicitSource: false }).allowedOperations).toEqual([]);
});
