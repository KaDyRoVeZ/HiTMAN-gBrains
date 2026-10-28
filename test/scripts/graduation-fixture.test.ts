/**
 * The graduation fixture cache restores a working managed brain at a new path.
 *
 * Protects: `scripts/persistence/graduation-fixture.ts`, which the 1k/10k
 * graduation round trips and the crash suite use to avoid rebuilding history
 * (the 10k build takes about 18 minutes). A restored tarball has new inodes
 * and a new directory, so every owner stamp, reservation, managed-root record
 * and database path must be re-homed or the first managed write refuses with
 * a physical-root error.
 * Regression it catches: a new path-bearing identity file or column that the
 * re-home misses, a cache key that ignores the fixture sources, or a report
 * that stops counting chunks, versions, requests or embeddings.
 * Not covered elsewhere: no other test restores a cached fixture. No production seam.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { assertPhysicalRoot } from '../../src/core/persistence/physical-root.ts';
import { graduationFixtureKey, prepareGraduationFixture, type GraduationFixture } from '../../scripts/persistence/graduation-fixture.ts';
import { legacySourceMismatches } from '../fixtures/graduation/legacy-brain.ts';
import { withEnv } from '../helpers/with-env.ts';

const scratch = mkdtempSync(join(tmpdir(), 'gbrain-graduation-fixture-'));
const cacheDir = join(scratch, 'cache');
let built: GraduationFixture;
let restored: GraduationFixture;
let engine: PGLiteEngine;

beforeAll(async () => {
  built = await prepareGraduationFixture({ kind: 'legacy', dir: join(scratch, 'built'), cacheDir });
  restored = await prepareGraduationFixture({ kind: 'legacy', dir: join(scratch, 'restored'), cacheDir });
  engine = new PGLiteEngine();
  await withEnv({ GBRAIN_HOME: restored.home }, () => engine.connect({ database_path: restored.dataDir }));
}, 180_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(scratch, { recursive: true, force: true });
});

describe('graduation fixture cache', () => {
  test('the first prepare builds and caches; the second restores the same report', () => {
    expect(built.cached).toBe(false);
    expect(readdirSync(cacheDir).filter(name => name.endsWith('.tar.gz'))).toEqual([`legacy-${built.key}.tar.gz`]);
    expect(restored.cached).toBe(true);
    expect(restored.report).toEqual(built.report);
    expect(restored.report).toMatchObject({ pages: 9, chunks: 7, versions: 2, requests: 4, effects: 6, embeddings: { chunks: 1, facts: 1, takes: 0 } });
  });

  test('the restored brain matches expected.json and its managed root holds at the new path', async () => {
    await withEnv({ GBRAIN_HOME: restored.home }, async () => {
      expect(await legacySourceMismatches(engine)).toEqual([]);
      const bindings = await engine.executeRaw<{ worktree_id: string; local_path: string; coordination_path: string }>(
        'SELECT worktree_id,local_path,coordination_path FROM persistence_host_bindings');
      expect(bindings.length).toBe(1);
      for (const binding of bindings) {
        expect(binding.local_path.startsWith(restored.dir)).toBe(true);
        expect(binding.coordination_path.startsWith(restored.home)).toBe(true);
        expect(() => assertPhysicalRoot(binding.local_path, { worktreeId: binding.worktree_id, coordinationPath: binding.coordination_path })).not.toThrow();
      }
      const stale = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE local_path IS NOT NULL AND last_sync_at IS NULL');
      expect(stale).toEqual([]);
    });
  });

  test('the cache key changes with the seed and the page count', async () => {
    const base = { kind: 'history' as const, dir: scratch, pages: 1000, seed: 1 };
    const key = await graduationFixtureKey(base);
    expect(await graduationFixtureKey({ ...base, seed: 2 })).not.toBe(key);
    expect(await graduationFixtureKey({ ...base, pages: 10_000 })).not.toBe(key);
    expect(await graduationFixtureKey({ ...base, dir: join(scratch, 'elsewhere') })).toBe(key);
  });
});
