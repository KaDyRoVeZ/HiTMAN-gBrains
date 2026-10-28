/**
 * #7130 on classic (unmanaged) sync: the lanes that turn a missing file into a page deletion outside the managed pass.
 * On a real PGLite brain, this protects:
 * - `sync --full` keeps every stale page when Git cannot list the history that proves a file was committed (a dangling
 *   ref fails `git log --all`); it used to skip the #2426 never-committed gate and delete them all;
 * - the absolute caps (`sync.max_deletes`, per source too) withhold a classic full reconcile and a working-tree sync
 *   below the 50% valve, and `GBRAIN_ALLOW_MASS_RECONCILE=1` still lets the deletion through;
 * - the working-tree valve's ratio is of the source's file-backed pages, so database-only pages cannot dilute it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { performSync } from '../src/commands/sync.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (name: string) => `---\ntype: concept\ntitle: ${name}\n---\n\nThe body of ${name}.\n`;

let engine: PGLiteEngine;
let repoPath: string;
const sync = (extra: Record<string, unknown> = {}) => performSync(engine, { repoPath, sourceId: 'default', noPull: true, noEmbed: true, noExtract: true, ...extra } as never);
const live = async () => (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);
function seed(names: string[]) {
  mkdirSync(join(repoPath, 'notes'), { recursive: true });
  for (const name of names) writeFileSync(join(repoPath, `notes/${name}.md`), note(name));
  commit(repoPath, 'notes');
}

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  if (repoPath) rmSync(repoPath, { recursive: true, force: true });
  repoPath = mkdtempSync(join(tmpdir(), 'gbrain-7130-classic-'));
  git(repoPath, 'init', '-q');
  await engine.setConfig('sync.repo_path', repoPath);
});

describe('#7130 classic sync: a missing file is deletion evidence only when Git proves it was removed', () => {
  test('sync --full keeps every stale page when git log --all fails (dangling ref)', async () => {
    seed(['a', 'b', 'gone']);
    expect(['first_sync', 'synced']).toContain((await sync({ full: true })).status);
    await engine.putPage('memories/lost', { type: 'concept', title: 'Lost', compiled_truth: 'Only the brain holds this.', timeline: '', frontmatter: { type: 'concept' } });
    await engine.executeRaw("UPDATE pages SET source_path = 'memories/lost.md' WHERE slug = 'memories/lost' AND source_id = 'default'");
    git(repoPath, 'rm', '-q', 'notes/gone.md');
    commit(repoPath, 'remove gone');
    writeFileSync(join(repoPath, '.git/refs/heads/dangling'), '1111111111111111111111111111111111111111\n');
    await sync({ full: true });
    expect(await live()).toEqual(['memories/lost', 'notes/a', 'notes/b', 'notes/gone']);
    // Control: with the history readable again, only the committed-then-removed page goes.
    rmSync(join(repoPath, '.git/refs/heads/dangling'));
    await sync({ full: true });
    expect(await live()).toEqual(['memories/lost', 'notes/a', 'notes/b']);
  }, 120_000);

  test('sync.max_deletes withholds a classic full reconcile below the 50% valve; the env valve lets it through', async () => {
    seed(Array.from({ length: 40 }, (_, i) => `n${String(i).padStart(2, '0')}`));
    expect(['first_sync', 'synced']).toContain((await sync({ full: true })).status);
    await engine.setConfig('sync.max_deletes.source.default', '5');
    for (let i = 0; i < 10; i++) git(repoPath, 'rm', '-q', `notes/n${String(i).padStart(2, '0')}.md`);
    commit(repoPath, 'remove ten');
    await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: undefined }, () => sync({ full: true }));
    expect((await live()).length).toBe(40);
    await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: '1' }, () => sync({ full: true }));
    expect((await live()).length).toBe(30);
  }, 120_000);

  test('the working-tree valve counts the source\'s file-backed pages, not its database-only pages', async () => {
    seed(Array.from({ length: 20 }, (_, i) => `n${String(i).padStart(2, '0')}`));
    expect(['first_sync', 'synced']).toContain((await sync()).status);
    for (let i = 0; i < 30; i++) await engine.putPage(`memories/m${i}`, { type: 'concept', title: `m${i}`, compiled_truth: `Database-only note ${i}.`, timeline: '', frontmatter: { type: 'concept' } });
    for (let i = 0; i < 12; i++) rmSync(join(repoPath, `notes/n${String(i).padStart(2, '0')}.md`));
    await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: undefined }, () => sync({ workingTree: true }));
    expect((await live()).filter(slug => slug.startsWith('notes/')).length).toBe(20);
  }, 120_000);

  test('sync.max_deletes withholds a working-tree sync\'s uncommitted deletions', async () => {
    seed(Array.from({ length: 40 }, (_, i) => `n${String(i).padStart(2, '0')}`));
    expect(['first_sync', 'synced']).toContain((await sync()).status);
    await engine.setConfig('sync.max_deletes', '5');
    for (let i = 0; i < 10; i++) rmSync(join(repoPath, `notes/n${String(i).padStart(2, '0')}.md`));
    await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: undefined }, () => sync({ workingTree: true }));
    expect((await live()).length).toBe(40);
    await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: '1' }, () => sync({ workingTree: true }));
    expect((await live()).length).toBe(30);
  }, 120_000);
});
