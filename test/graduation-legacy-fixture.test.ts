/**
 * The independent legacy fixture for engine graduation builds exactly the
 * brain its hand-written expected.json describes, and the target checker
 * discriminates.
 *
 * Protects: the graduation gate's legacy input (test/fixtures/graduation/).
 * Every graduation round trip, crash and rollback test trusts that the source
 * holds the states expected.json names (legacy unattributed rows, a failed,
 * a delayed and an orphan running effect, a stale minion lease, a queued
 * request, withdrawals with an overlay, revoked and live tokens, byte-heavy
 * rows, collation-sensitive text keys). A schema or handler change that
 * silently stops producing one of those states would turn those tests
 * vacuous; this file fails first and names the state.
 * Regression it catches: a migration that changes a trigger the fixture
 * relies on (fact withdrawal stamping, generation bumps, projection queue),
 * activation absorbing the orphan states, or the target checker passing an
 * untransformed copy.
 * Not covered elsewhere: no other test builds this fixture. No production seam.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import {
  buildLegacyBrain, legacySourceMismatches, legacyTargetMismatches, loadLegacyExpected, readQueuedAdmission, snapshotLegacySource,
  type LegacyBrainFixture,
} from './fixtures/graduation/legacy-brain.ts';

let engine: PGLiteEngine;
let fixture: LegacyBrainFixture;
const root = mkdtempSync(join(tmpdir(), 'gbrain-legacy-fixture-'));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  fixture = await buildLegacyBrain(engine, { root });
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  rmSync(root, { recursive: true, force: true });
});

describe('graduation legacy fixture', () => {
  test('the built brain matches every source expectation in expected.json', async () => {
    expect(await legacySourceMismatches(engine)).toEqual([]);
  });

  test('the queued admission is recorded with its caller intent for a cross-process replay probe', () => {
    expect(existsSync(join(root, 'queued-admission.json'))).toBe(true);
    const recorded = readQueuedAdmission(root);
    expect(recorded.requestId).toBe(loadLegacyExpected().source.queued_request.request_id);
    expect(recorded.callerIntent).toEqual(fixture.queued.callerIntent);
    expect(recorded.worktreeId).toBe(fixture.worktreeId);
  });

  test('the target checker reports exactly the graduation transforms when handed the untransformed source', async () => {
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine) });
    const before = await snapshotLegacySource(engine);
    const mismatches = await legacyTargetMismatches(engine, before, token => provider.verifyAccessToken(token));
    const labels = mismatches.map(m => m.split(':')[0]).sort();
    expect(labels).toEqual([
      'target count gbrain_cycle_locks', 'target count pages', 'target effect orphan_running', 'target gbrain_cycle_locks discarded',
      'target queued request', 'target stale job', 'target worktree heartbeat',
    ]);
  });
});
