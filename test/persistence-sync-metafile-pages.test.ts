/**
 * GBRA-150: managed sync under `sync.metafile_pages`. A typed nested metafile is a page for the managed level pass
 * (sync-pass.ts), discovery and the unindexed-file detector; a bare one is outside the level, so it never counts as
 * missing and the pass converges. A deleted typed metafile soft-deletes its page, an existing typed file imports on the
 * first sync after the upgrade, and `off` keeps the detector's metafile_skipped report.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { shadowConvergence } from '../src/core/persistence/sync-pass.ts';
import { findUnindexedFiles } from '../src/core/persistence/unindexed-files.ts';
import { SYNC_METAFILE_PAGES_KEY } from '../src/core/sync.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const home = mkdtempSync(join(tmpdir(), 'gbrain-metafile-managed-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content'); return git(root, 'rev-parse', 'HEAD'); };
const TYPED_INDEX = '---\ntype: project\ntitle: Acme Example\n---\n\nThe project hub for acme-example.\n';
const BARE_README = '# Notes\n\nScaffolding that lists the folder.\n';
const note = (title: string) => '---\ntitle: ' + title + '\n---\nA synthetic observation.\n';

beforeAll(async () => {
  if (backends.includes('pglite')) { const engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); engines.push(engine); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});

async function source(engine: BrainEngine, files: Record<string, string>) {
  const id = 'metafile-' + randomUUID().replace(/-/g, '').slice(0, 20), repo = join(home, id);
  const write = (path: string, content: string) => { mkdirSync(join(repo, path, '..'), { recursive: true }); writeFileSync(join(repo, path), content); };
  mkdirSync(repo, { recursive: true }); git(repo, 'init', '-q');
  for (const [path, content] of Object.entries(files)) write(path, content);
  commit(repo);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, repo, '{}']);
  await claimWorktree(engine, id, repo);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const sync = (extra: Partial<SyncOpts> = {}) => performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true, ...extra });
  const live = async (slug: string) => (await engine.executeRaw<{ deleted_at: string | null }>('SELECT deleted_at FROM pages WHERE source_id=$1 AND slug=$2', [id, slug]))[0];
  const convergence = async () => (await shadowConvergence(engine, { sourceId: id }))!;
  return { id, repo, write, sync, live, convergence, commit: () => commit(repo) };
}

async function each(run: (engine: BrainEngine) => Promise<void>) {
  await withEnv(env, async () => {
    for (const engine of engines) {
      try { await run(engine); } finally { await engine.executeRaw('DELETE FROM config WHERE key=$1', [SYNC_METAFILE_PAGES_KEY]); await disposePersistenceConsumer(engine); }
    }
  });
}

test('managed sync imports a typed nested index.md, skips bare and root metafiles, and the level pass converges', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'projects/acme-example/index.md': TYPED_INDEX, 'notes/README.md': BARE_README, 'index.md': TYPED_INDEX });
  const first = await s.sync();
  expect(first.status).toBe('first_sync');
  expect(await engine.getPage('projects/acme-example/index', { sourceId: s.id })).not.toBeNull();
  expect(await engine.getPage('notes/readme', { sourceId: s.id })).toBeNull();
  expect(await engine.getPage('index', { sourceId: s.id })).toBeNull();
  const level = await s.convergence();
  expect(level.counts).toEqual({ matched: 2 });
  expect((await s.sync()).status).toBe('up_to_date');
}), 240_000);

test('deleting a typed nested metafile soft-deletes its page in managed sync; a bare one is never in the level', () => each(async engine => {
  const s = await source(engine, { 'notes/a.md': note('A'), 'projects/acme-example/index.md': TYPED_INDEX, 'notes/README.md': BARE_README });
  await s.sync();
  unlinkSync(join(s.repo, 'projects/acme-example/index.md'));
  unlinkSync(join(s.repo, 'notes/README.md'));
  s.commit();
  const result = await s.sync();
  expect(result.deleted).toBe(1);
  expect((await s.live('projects/acme-example/index'))?.deleted_at).not.toBeNull();
  expect((await s.convergence()).counts).toEqual({ matched: 1 });
}), 240_000);

test('an existing typed file imports on the first managed sync after the upgrade; the unindexed detector schedules it instead of metafile_skipped', () => each(async engine => {
  await engine.setConfig(SYNC_METAFILE_PAGES_KEY, 'off');
  const s = await source(engine, { 'notes/a.md': note('A'), 'projects/acme-example/index.md': TYPED_INDEX, 'notes/README.md': BARE_README });
  await s.sync();
  expect(await engine.getPage('projects/acme-example/index', { sourceId: s.id })).toBeNull();
  expect(await findUnindexedFiles(engine, s.id)).toMatchObject({ unindexed: 0, metafile_skipped: 1, metafile_samples: ['projects/acme-example/index.md'] });
  await engine.executeRaw('DELETE FROM config WHERE key=$1', [SYNC_METAFILE_PAGES_KEY]);
  const scan = await findUnindexedFiles(engine, s.id);
  expect(scan).toMatchObject({ unindexed: 1, metafile_skipped: 0 });
  expect(scan.files.map(file => file.path)).toEqual(['projects/acme-example/index.md']);
  const upgraded = await s.sync();
  expect(['synced', 'first_sync']).toContain(upgraded.status);
  expect(upgraded.deleted ?? 0).toBe(0);
  expect(await engine.getPage('projects/acme-example/index', { sourceId: s.id })).not.toBeNull();
  expect(await engine.getPage('notes/readme', { sourceId: s.id })).toBeNull();
  expect((await s.convergence()).counts).toEqual({ matched: 2 });
}), 240_000);
