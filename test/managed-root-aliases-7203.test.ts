/**
 * #7203: managed filesystem roots are deduplicated by filesystem identity, not
 * by the stored spelling. A bound worktree and an unbound source path that
 * alias one directory (a symlink, a trailing slash, macOS /var vs /private/var,
 * a case variant) leave one canonical record that keeps the bound identity,
 * whichever spelling sorts first, and an idle refresh rewrites nothing.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { assertManagedFilesystemWrite, managedFilesystemRootFor, refreshManagedFilesystemRoots } from '../src/core/persistence/filesystem-guard.ts';
import { readPersistenceBrain } from '../src/core/persistence/managed-mode.ts';
import { canonicalFilesystemPath, canonicalManagedRoots, recordManagedRoots } from '../src/core/persistence/root-registry.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const caseInsensitive = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-case-probe-'));
  try { mkdirSync(join(dir, 'probe')); return existsSync(join(dir, 'PROBE')); } finally { rmSync(dir, { recursive: true, force: true }); }
})();

async function setSourcePath(engine: BrainEngine, kind: 'same' | 'other', path: string): Promise<void> {
  await engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true)");
    if (kind === 'same') await tx.executeRaw("UPDATE sources SET local_path=$1 WHERE id='default'", [path]);
    else await tx.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['alias-source', path]);
  });
}

function registry(home: string) {
  const dir = join(home, '.gbrain', 'persistence', 'managed-roots');
  return readdirSync(dir).filter(file => file.endsWith('.json')).map(file => {
    const stat = statSync(join(dir, file), { bigint: true });
    return { file, stamp: `${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`, record: JSON.parse(readFileSync(join(dir, file), 'utf8')) };
  });
}

type Spelling = { name: string; make: (home: string, root: string) => string; skip?: boolean };
const spellings: Spelling[] = [
  { name: 'symlink sorting before the real path', make: (home, root) => { const alias = join(home, 'aaa-alias'); symlinkSync(root, alias); return alias; } },
  { name: 'symlink sorting after the real path', make: (home, root) => { const alias = join(home, 'zzz-alias'); symlinkSync(root, alias); return alias; } },
  { name: 'trailing slash', make: (_home, root) => `${root}/` },
  { name: 'case variant (case-insensitive filesystem only)', make: (home, root) => join(home, basename(root).toUpperCase()), skip: !caseInsensitive },
];

for (const backend of testBackends()) {
  describe(`managed-root aliases keep the bound record (${backend})`, () => {
    for (const spelling of spellings) for (const kind of ['same', 'other'] as const) {
      test.skipIf(!!spelling.skip)(`${spelling.name}, ${kind === 'same' ? 'same source' : 'second source'}`, async () => {
        await managedBrain(async ({ engine, root }) => {
          const home = join(root, '..');
          const alias = spelling.make(home, root);
          const [bound] = await engine.executeRaw<{ worktree_id: string; topology_generation: string }>(
            "SELECT worktree_id::text AS worktree_id, topology_generation::text AS topology_generation FROM persistence_source_bindings WHERE source_id='default'");
          await setSourcePath(engine, kind, alias);
          await refreshManagedFilesystemRoots(engine);
          const first = registry(home);
          const records = first.filter(entry => entry.record.root === canonicalFilesystemPath(root));
          expect(records).toHaveLength(1);
          expect(records[0]!.record).toMatchObject({ source_id: 'default', worktree_id: bound!.worktree_id, topology_generation: bound!.topology_generation });
          expect(managedFilesystemRootFor(join(alias, 'note.md'))?.sourceId).toBe('default');
          for (const path of [join(root, 'note.md'), join(alias, 'note.md')]) {
            expect(() => assertManagedFilesystemWrite(path)).toThrow('managed canonical worktree');
          }
          // Past the filesystem timestamp tick, so a rewrite with a recycled inode still shows.
          await new Promise(resolve => setTimeout(resolve, 50));
          await refreshManagedFilesystemRoots(engine);
          expect(registry(home).map(entry => entry.stamp)).toEqual(first.map(entry => entry.stamp));
        }, { databaseUrl: backend === 'pglite' ? undefined : requirePostgresTestDatabase() });
      }, 120_000);
    }

    test('a record an alias already overwrote heals to the bound identity on the next refresh', async () => {
      await managedBrain(async ({ engine, root }) => {
        const home = join(root, '..');
        const alias = join(home, 'zzz-alias'); symlinkSync(root, alias);
        await setSourcePath(engine, 'other', alias);
        const brain = await readPersistenceBrain(engine);
        recordManagedRoots(brain.brain_id, [{ local_path: alias, source_id: 'alias-source' }], Number(brain.mode_epoch));
        expect(registry(home).find(entry => entry.record.root === canonicalFilesystemPath(root))?.record.source_id).toBe('alias-source');
        await refreshManagedFilesystemRoots(engine);
        const healed = registry(home).filter(entry => entry.record.root === canonicalFilesystemPath(root));
        expect(healed).toHaveLength(1);
        expect(healed[0]!.record.source_id).toBe('default');
        expect(typeof healed[0]!.record.worktree_id).toBe('string');
        expect(managedFilesystemRootFor(join(alias, 'note.md'))?.sourceId).toBe('default');
      }, { databaseUrl: backend === 'pglite' ? undefined : requirePostgresTestDatabase() });
    }, 120_000);
  });
}

test('canonicalManagedRoots is independent of input order and spelling', () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-canonical-roots-'));
  try {
    const real = join(home, 'real'); mkdirSync(real);
    const alias = join(home, 'alias'); symlinkSync(real, alias);
    const rows = [
      { local_path: alias, source_id: 'source-b', source_incarnation: 'b1' },
      { local_path: `${real}/`, source_id: 'source-c', source_incarnation: 'c1' },
      { local_path: real, source_id: 'source-a', source_incarnation: 'a1', worktree_id: '00000000-0000-4000-8000-000000000001', topology_generation: 3 },
    ];
    const expected = [{ ...rows[2]!, local_path: canonicalFilesystemPath(real) }];
    expect(canonicalManagedRoots(rows)).toEqual(expected);
    expect(canonicalManagedRoots([...rows].reverse())).toEqual(expected);
    expect(canonicalManagedRoots([rows[1]!, rows[2]!, rows[0]!])).toEqual(expected);
    expect(canonicalManagedRoots([rows[0]!, rows[1]!])).toEqual(canonicalManagedRoots([rows[1]!, rows[0]!]));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
