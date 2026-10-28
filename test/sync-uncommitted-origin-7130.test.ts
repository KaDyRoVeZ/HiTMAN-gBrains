/**
 * #7130 (reported by @liuwenyong1985): a managed sync soft-deleted thousands of pages whose recorded file was absent but
 * had never been committed (agent-written pages whose write-through file landed in a .gitignore'd directory), and the
 * 50% valve never tripped because they were 4% of a large source. On a real managed brain (PGLite, and Postgres with
 * DATABASE_URL), this protects:
 * - a live page whose file is absent and was never committed is held (`file_drift`, side deleted, reason
 *   `never_committed`), never deleted, in committed mode, in working mode, under `--full`, and in the dry run's
 *   discovery; one under a path .gitignore excludes is held with reason `ignored`; a committed then removed file still
 *   deletes its page;
 * - `sync.max_deletes` (and its per-source override) withholds a pass below the 50% valve through the deletes_withheld
 *   record, and status's next step for it is ask_user;
 * - put_page into a .gitignore'd directory writes no file and binds no origin (the page is database-only).
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { discoverManagedSync } from '../src/core/persistence/sync-discovery.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { SYNC_DELETES_WITHHELD_OP } from '../src/core/persistence/sync-pass-row.ts';
import { cliRenderContext, renderAction } from '../src/core/agent-output.ts';
import { DEFAULT_SYNC_MAX_DELETES, DEFAULT_SYNC_MAX_DELETE_RATIO, readSyncDeleteCaps, syncDeleteTrip } from '../src/core/sync-reconcile.ts';
import { gitIgnoresUntracked, readOriginEvidence } from '../src/core/persistence/sync-origin-evidence.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { waitFor } from './helpers/wait-for.ts';
import { withEnv } from './helpers/with-env.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setupNotes = (names: string[], gitignore = '') => ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  if (gitignore) writeFileSync(join(root, '.gitignore'), gitignore);
  for (const name of names) writeFileSync(join(root, `notes/${name}.md`), note(`notes/${name}`, `The committed body of notes/${name}.`));
  commit(root, 'notes');
};
const liveSlugs = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id='default' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);
async function holds(engine: BrainEngine) {
  const rows = await engine.executeRaw<{ fingerprint: string; record: { code: string; slug: string | null; message: string; meta: Record<string, unknown> } }>(
    "SELECT fingerprint, completed_keys->0 AS record FROM op_checkpoints WHERE op='sync-hold' ORDER BY fingerprint");
  return Object.fromEntries(rows.map(row => [row.fingerprint.split(':').slice(2).join(':'), row.record]));
}
/** Imports untracked files from the working tree (working mode), then returns to committed mode. */
async function importUntracked(engine: BrainEngine, root: string, files: Record<string, string>) {
  for (const [path, body] of Object.entries(files)) { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), note(path.replace(/\.md$/, ''), body)); }
  await engine.setConfig('sync.include_working_tree', 'true');
  expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
  await engine.setConfig('sync.include_working_tree', 'false');
}

for (const backend of testBackends()) describe(`[${backend}] #7130: an absent file Git never committed is no deletion evidence`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test('never committed, ignored, and committed-then-removed: only the last deletes its page, in a pass and under --full; the dry run agrees', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await importUntracked(engine, root, { 'notes/draft.md': 'An untracked draft only the brain holds.', 'scratch/agent.md': 'An agent page written to scratch/.' });
    expect(await liveSlugs(engine)).toEqual(['notes/a', 'notes/b', 'notes/c', 'notes/draft', 'scratch/agent']);
    // scratch/ becomes ignored; the untracked files leave the disk; notes/c is removed in a commit.
    writeFileSync(join(root, '.gitignore'), 'scratch/\n');
    rmSync(join(root, 'notes/draft.md')); rmSync(join(root, 'scratch'), { recursive: true });
    git(root, 'rm', '-q', 'notes/c.md');
    commit(root, 'ignore scratch, remove c');

    const discovery = await discoverManagedSync(engine, { ...OPTS, full: true, dryRun: true } as never);
    expect(discovery.entries.filter(entry => entry.action === 'delete').map(entry => entry.sourcePath).sort()).toEqual(['notes/c.md']);
    expect([...discovery.uncommittedKept ?? []].sort()).toEqual(['notes/draft.md', 'scratch/agent.md']);

    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    expect(await liveSlugs(engine)).toEqual(['notes/a', 'notes/b', 'notes/draft', 'scratch/agent']);
    const held = await holds(engine);
    expect(held['notes/draft.md']).toMatchObject({ code: 'file_drift', slug: 'notes/draft', meta: { side: 'deleted', state: 'file_gone', reason: 'never_committed', deleted: true } });
    expect(held['scratch/agent.md']).toMatchObject({ code: 'file_drift', slug: 'scratch/agent', meta: { side: 'deleted', state: 'file_gone', reason: 'ignored', deleted: true } });
    expect(held['notes/draft.md']!.message).toContain('no evidence');
    // Held at their level: the next tick and a full re-walk delete nothing.
    expect((await performManagedSync(engine, OPTS)).status).toBe('up_to_date');
    await performManagedSync(engine, { ...OPTS, full: true });
    expect(await liveSlugs(engine)).toEqual(['notes/a', 'notes/b', 'notes/draft', 'scratch/agent']);
  }, { databaseUrl, setup: setupNotes(['a', 'b', 'c']) }), 240_000);

  test('working mode: an untracked file removed from the disk holds its page instead of deleting it', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.setConfig('sync.include_working_tree', 'true');
    writeFileSync(join(root, 'notes/w.md'), note('notes/w', 'An untracked working-tree note.'));
    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    rmSync(join(root, 'notes/w.md'));
    await performManagedSync(engine, OPTS);
    expect(await liveSlugs(engine)).toContain('notes/w');
    expect((await holds(engine))['notes/w.md']).toMatchObject({ code: 'file_drift', meta: { reason: 'never_committed' } });
  }, { databaseUrl, setup: setupNotes(['a']) }), 240_000);

  const names = Array.from({ length: 24 }, (_, i) => `n${String(i).padStart(2, '0')}`);
  test('sync.max_deletes withholds a pass below the 50% valve; next is ask_user; a source override and the env valve apply it', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await engine.setConfig('sync.max_deletes', '3');
    for (const name of names.slice(0, 4)) git(root, 'rm', '-q', `notes/${name}.md`);
    commit(root, 'remove four of 24');

    expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
    expect((await liveSlugs(engine)).length).toBe(24);
    const [withheld] = await engine.executeRaw<{ value: { count: number; trip: string; caps: { maxDeletes: number } } }>('SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1', [SYNC_DELETES_WITHHELD_OP]);
    expect(withheld!.value).toMatchObject({ count: 4, trip: 'max_deletes', caps: { maxDeletes: 3 } });
    const status = await readSyncStatus(engine, 'default', { detail: false });
    expect({ state: status.state, reason: status.reason }).toEqual({ state: 'blocked', reason: 'deletes_withheld' });
    expect(renderAction(status.next!, cliRenderContext()).next).toBe('ask_user');
    expect(status.next!.user_message).toContain('sync.max_deletes');

    await engine.setConfig('sync.max_deletes.source.default', '10');
    expect((await performManagedSync(engine, { ...OPTS, full: true })).status).toBe('synced');
    expect((await liveSlugs(engine)).length).toBe(20);
    expect(await engine.executeRaw('SELECT 1 FROM op_checkpoints WHERE op=$1', [SYNC_DELETES_WITHHELD_OP])).toHaveLength(0);

    await engine.setConfig('sync.max_deletes.source.default', '1');
    for (const name of names.slice(4, 6)) git(root, 'rm', '-q', `notes/${name}.md`);
    commit(root, 'remove two more');
    await performManagedSync(engine, OPTS);
    expect((await liveSlugs(engine)).length).toBe(20);
    await withEnv({ GBRAIN_ALLOW_MASS_RECONCILE: '1' }, async () => { await performManagedSync(engine, OPTS); });
    expect((await liveSlugs(engine)).length).toBe(18);
  }, { databaseUrl, setup: setupNotes(names) }), 240_000);

  test('put_page into a .gitignore\'d directory writes no file and binds no origin; sync never deletes it', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    const requestId = randomUUID();
    await submitPageMutation(ctx as OperationContext, { operation: 'put_page', params: { slug: 'ingested/report', request_id: requestId, content: note('ingested/report', 'An agent-written report.') } });
    await waitFor(async () => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]?.state === 'committed',
      { timeoutMs: 20_000, label: 'put_page commits' });
    expect(existsSync(join(root, 'ingested/report.md'))).toBe(false);
    const [page] = await engine.executeRaw<{ source_path: string | null }>("SELECT source_path FROM pages WHERE source_id='default' AND slug='ingested/report' AND deleted_at IS NULL");
    expect(page).toEqual({ source_path: null });
    await performManagedSync(engine, { ...OPTS, full: true });
    expect(await liveSlugs(engine)).toContain('ingested/report');
  }, { databaseUrl, setup: setupNotes(['a'], 'ingested/\n') }), 240_000);

  test('a page that already records a file keeps it when a rule later ignores it: an unimported disk edit still refuses the write (source_changed)', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
    await importUntracked(engine, root, { 'drafts/x.md': 'A draft imported from the working tree.' });
    writeFileSync(join(root, '.gitignore'), 'drafts/\n');
    writeFileSync(join(root, 'drafts/x.md'), note('drafts/x', 'A newer edit on disk that no sync imported.'));
    const requestId = randomUUID();
    const revision = (await engine.readPageSnapshot('drafts/x', { sourceId: 'default' }))!.revision;
    const refusal = await submitPageMutation(ctx as OperationContext, { operation: 'put_page', params: { slug: 'drafts/x', request_id: requestId, expected_revision: revision, content: note('drafts/x', 'An agent rewrite.') } })
      .then(() => null, (error: { code?: string }) => error.code ?? 'unknown');
    await waitFor(async () => refusal !== null || ['committed', 'failed', 'cancelled', 'conflict'].includes((await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [requestId]))[0]?.state ?? ''),
      { timeoutMs: 20_000, label: 'put_page settles' });
    const [request] = await engine.executeRaw<{ error_code: string | null }>('SELECT error_code FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    expect(request?.error_code ?? refusal).toBe('source_changed');
    const page = await engine.getPage('drafts/x', { sourceId: 'default' });
    expect(page?.compiled_truth).not.toContain('An agent rewrite.');
    expect((await engine.executeRaw<{ source_path: string | null }>("SELECT source_path FROM pages WHERE source_id='default' AND slug='drafts/x'"))[0]).toEqual({ source_path: 'drafts/x.md' });
  }, { databaseUrl, setup: setupNotes(['a']) }), 240_000);
});

describe('#7130: origin evidence', () => {
  test('committed, never committed and ignored paths; a read that fails answers unknown (the classifier holds it)', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const root = mkdtempSync(join(tmpdir(), 'gbrain-7130-evidence-'));
    try {
      git(root, 'init', '-q'); mkdirSync(join(root, 'notes'));
      writeFileSync(join(root, '.gitignore'), 'scratch/\n'); writeFileSync(join(root, 'notes/gone "quoted" é.md'), 'x');
      commit(root, 'one'); git(root, 'rm', '-q', 'notes/gone "quoted" é.md'); commit(root, 'two');
      const head = git(root, 'rev-parse', 'HEAD');
      const evidence = await readOriginEvidence(root, [head, null], ['notes/gone "quoted" é.md', 'notes/never.md', 'scratch/agent.md']);
      expect(Object.fromEntries(evidence)).toEqual({ 'notes/gone "quoted" é.md': 'committed', 'notes/never.md': 'never_committed', 'scratch/agent.md': 'ignored' });
      expect(Object.fromEntries(await readOriginEvidence(join(root, 'missing'), [head], ['notes/never.md']))).toEqual({ 'notes/never.md': 'unknown' });
      expect(await gitIgnoresUntracked(root, 'scratch/agent.md')).toBe(true);
      expect(await gitIgnoresUntracked(root, 'notes/never.md')).toBe(false);
      // A name is read byte for byte: only ' lead.md' and '\nlead.md' were committed, so 'lead.md' has no commit. A removed
      // file that a later rule ignores is still committed (its removal is a real deletion).
      writeFileSync(join(root, ' lead.md'), 'x'); writeFileSync(join(root, '\nlead.md'), 'y'); mkdirSync(join(root, 'old')); writeFileSync(join(root, 'old/x.md'), 'x');
      commit(root, 'three'); git(root, 'rm', '-q', ' lead.md', '\nlead.md', 'old/x.md'); writeFileSync(join(root, '.gitignore'), 'scratch/\nold/\n'); commit(root, 'four');
      const later = await readOriginEvidence(root, [git(root, 'rev-parse', 'HEAD')], [' lead.md', '\nlead.md', 'lead.md', 'old/x.md']);
      expect(Object.fromEntries(later)).toEqual({ ' lead.md': 'committed', '\nlead.md': 'committed', 'lead.md': 'never_committed', 'old/x.md': 'committed' });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('#7130: delete caps', () => {
  test('defaults and trips', async () => {
    expect({ max: DEFAULT_SYNC_MAX_DELETES, ratio: DEFAULT_SYNC_MAX_DELETE_RATIO }).toEqual({ max: 500, ratio: 0.01 });
    const caps = { maxDeletes: 500, maxDeleteRatio: 0.01 };
    expect(syncDeleteTrip(0, 478_000, caps)).toBeNull();
    expect(syncDeleteTrip(19_325, 478_000, caps)).toBe('max_deletes');
    expect(syncDeleteTrip(400, 30_000, caps)).toBe('max_delete_ratio');
    expect(syncDeleteTrip(50, 2_000, caps)).toBeNull();
    expect(syncDeleteTrip(51, 2_000, caps)).toBe('max_delete_ratio');
    expect(syncDeleteTrip(14, 24, caps)).toBe('mass_ratio');
    expect(syncDeleteTrip(3, 24, caps)).toBeNull();
    const config = new Map<string, string>([['sync.max_deletes', '40'], ['sync.max_delete_ratio', 'nonsense'], ['sync.max_deletes.source.other', '7']]);
    const engine = { getConfig: async (key: string) => config.get(key) ?? null };
    expect(await readSyncDeleteCaps(engine, 'default')).toEqual({ maxDeletes: 40, maxDeleteRatio: 0.01 });
    expect(await readSyncDeleteCaps(engine, 'other')).toEqual({ maxDeletes: 7, maxDeleteRatio: 0.01 });
  });
});
