/**
 * #2018/#7203: the write-through leak guard compares \`sync.repo_path\` with
 * every other source's own working tree by filesystem identity. A symlink, a
 * trailing slash or a case variant of another source's checkout is still that
 * checkout, so a page of a source with no local_path is never written into it;
 * a spelling that cannot be resolved fails closed. The doctor check
 * default_source_local_path names the same collision and counts pages that an
 * earlier misrouted write may already have duplicated.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { defaultSourceLocalPathCheck } from '../src/commands/doctor/checks/default-source-path.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { resolvePageWriteTarget } from '../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const caseInsensitive = (() => {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-case-probe-'));
  try { mkdirSync(join(dir, 'probe')); return existsSync(join(dir, 'PROBE')); } finally { rmSync(dir, { recursive: true, force: true }); }
})();

async function brain(backend: string, run: (engine: BrainEngine, home: string, tree: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-leak-guard-'));
  const { engine, close } = await isolatedSharedSkillsEngine(backend === 'pglite' ? undefined : requirePostgresTestDatabase());
  try {
    const tree = join(home, 'source-b-tree'); mkdirSync(tree);
    await engine.executeRaw("UPDATE sources SET local_path=NULL WHERE id='default'");
    await run(engine, home, tree);
  } finally { await close(); rmSync(home, { recursive: true, force: true }); }
}

type Spelling = { name: string; make: (home: string, tree: string) => string; skip?: boolean };
const spellings: Spelling[] = [
  { name: 'symlink', make: (home, tree) => { const alias = join(home, 'alias'); symlinkSync(tree, alias); return alias; } },
  { name: 'trailing slash', make: (_home, tree) => `${tree}/` },
  { name: 'case variant (case-insensitive filesystem only)', make: (home, tree) => join(home, basename(tree).toUpperCase()), skip: !caseInsensitive },
];

for (const backend of testBackends()) {
  describe(`write-through leak guard compares filesystem identity (${backend})`, () => {
    for (const spelling of spellings) for (const side of ['sync.repo_path', 'source local_path'] as const) {
      test.skipIf(!!spelling.skip)(`${spelling.name} on ${side} is refused`, async () => {
        await brain(backend, async (engine, home, tree) => {
          const alias = spelling.make(home, tree);
          await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['source-b', side === 'source local_path' ? alias : tree]);
          await engine.setConfig('sync.repo_path', side === 'sync.repo_path' ? alias : tree);
          expect(await resolvePageWriteTarget(engine, 'notes/x', 'default')).toEqual({ ok: false, skipped: 'source_repo_belongs_to_other_source' });
          expect(await resolvePageWriteTarget(engine, 'notes/x', 'source-c')).toEqual({ ok: false, skipped: 'source_repo_belongs_to_other_source' });
        });
      }, 60_000);
    }

    for (const spelling of ['real', 'symlink'] as const) {
      test(`sync.repo_path inside another source's checkout (${spelling} spelling) is refused`, async () => {
        await brain(backend, async (engine, home, tree) => {
          mkdirSync(join(tree, 'sub'));
          const base = spelling === 'real' ? tree : join(home, 'alias');
          if (spelling === 'symlink') symlinkSync(tree, base);
          await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['source-b', tree]);
          await engine.setConfig('sync.repo_path', join(base, 'sub'));
          expect(await resolvePageWriteTarget(engine, 'notes/x', 'default')).toEqual({ ok: false, skipped: 'source_repo_belongs_to_other_source' });
          expect(await resolvePageWriteTarget(engine, 'notes/x', 'source-c')).toEqual({ ok: false, skipped: 'source_repo_belongs_to_other_source' });
        });
      }, 60_000);

      test(`another source's checkout inside sync.repo_path (${spelling} spelling) refuses only writes that land in it`, async () => {
        await brain(backend, async (engine, home) => {
          const repo = join(home, 'repo'); mkdirSync(join(repo, 'notes'), { recursive: true });
          const nested = spelling === 'real' ? join(repo, 'notes') : join(home, 'notes-alias');
          if (spelling === 'symlink') symlinkSync(join(repo, 'notes'), nested);
          await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['source-b', nested]);
          await engine.setConfig('sync.repo_path', repo);
          expect(await resolvePageWriteTarget(engine, 'notes/x', 'default')).toEqual({ ok: false, skipped: 'source_repo_belongs_to_other_source' });
          expect(await resolvePageWriteTarget(engine, 'other/x', 'default')).toMatchObject({ ok: true, filePath: join(repo, 'other', 'x.md') });
        });
      }, 60_000);
    }

    test('a distinct checkout is not a collision', async () => {
      await brain(backend, async (engine, home, tree) => {
        const repo = join(home, 'repo'); mkdirSync(repo);
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['source-b', tree]);
        await engine.setConfig('sync.repo_path', repo);
        const target = await resolvePageWriteTarget(engine, 'notes/x', 'default');
        expect(target).toMatchObject({ ok: true, filePath: join(repo, 'notes', 'x.md') });
      });
    }, 60_000);

    test('another source path that cannot be resolved fails closed', async () => {
      await brain(backend, async (engine, home) => {
        const repo = join(home, 'repo'); mkdirSync(repo);
        const loop = join(home, 'loop'); symlinkSync(loop, loop);
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['source-b', loop]);
        await engine.setConfig('sync.repo_path', repo);
        expect(await resolvePageWriteTarget(engine, 'notes/x', 'default')).toEqual({ ok: false, skipped: 'source_repo_belongs_to_other_source' });
      });
    }, 60_000);

    test('doctor names a sync.repo_path nested inside another source\'s checkout', async () => {
      await brain(backend, async (engine, home, tree) => {
        mkdirSync(join(tree, 'sub'));
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['source-b', tree]);
        await engine.setConfig('sync.repo_path', join(tree, 'sub'));
        await engine.putPage('notes/x', { type: 'note', title: 'x', compiled_truth: 'body', timeline: '', frontmatter: {} }, { sourceId: 'default' });
        const check = await defaultSourceLocalPathCheck(engine);
        expect(check?.status).toBe('warn');
        expect(check?.message).toContain('is, or lies inside, source "source-b"\'s own working tree');
      });
    }, 60_000);

    test('doctor names the aliased collision and counts pages a misrouted write may have duplicated', async () => {
      await brain(backend, async (engine, home, tree) => {
        const alias = join(home, 'alias'); symlinkSync(tree, alias);
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['source-b', tree]);
        await engine.setConfig('sync.repo_path', alias);
        for (const [source, slug] of [['default', 'notes/x'], ['source-b', 'notes/x'], ['default', 'notes/y']] as const) {
          await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'body', timeline: '', frontmatter: {} }, { sourceId: source });
        }
        await engine.executeRaw("UPDATE pages SET source_path='notes/x.md' WHERE slug='notes/x'");
        const check = await defaultSourceLocalPathCheck(engine);
        expect(check?.status).toBe('warn');
        expect(check?.message).toContain('"source-b"\'s own working tree');
        expect(check?.message).toContain('1 default-source page(s) share a file path with a live "source-b" page');
      });
    }, 60_000);
  });
}
