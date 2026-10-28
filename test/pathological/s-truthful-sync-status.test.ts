/**
 * GBRA-133 PR 2b.5: status tells the truth about a commit that has not synced.
 *
 * Protects:
 *  - doctor managed_sync_latency grades the oldest unsynced commit, not only the commits that did sync: a managed
 *    source with an unsynced commit 10 minutes old warns (v0.60.316.0 said "No commit→searchable samples", ok), one
 *    the commit notifier has had due for 2 h fails, dated from its persisted first_due_at when there is no reflog;
 *  - with neither a reflog nor a first_due_at the wait reads unknown (no_reflog, or history_rewritten when the synced
 *    commit is not an ancestor of HEAD) and warns, never ok;
 *  - keyword-visible and embedded freshness are reported separately per source (an embedding backlog is reported,
 *    not graded);
 *  - the classic equivalent: a non-managed brain grades its classic sources' unsynced commits;
 *  - source-health compares HEAD only (a dirty tracked file is not lag) and dates lag from when the commit landed
 *    (reflog) or the notifier's first_due_at, not from the last no-op heartbeat of last_sync_at.
 * Every timing assertion reads a recorded timestamp (reflog entry, first_due_at, embedding_pending_since), never a
 * measured duration. PGLite always, Postgres when DATABASE_URL is set (twin: test/e2e/s-truthful-sync-status-postgres.test.ts).
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { managedSyncLatencyEntry } from '../../src/commands/doctor/checks/managed-sync-latency.ts';
import { computeAllSourceMetrics } from '../../src/core/source-health.ts';
import { loadAllSources } from '../../src/core/sources-load.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const SOURCE = 'acme-example';
const MINUTE = 60;

function git(root: string, args: string[], atSeconds?: number): string {
  const env = { ...process.env, GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
    ...(atSeconds === undefined ? {} : { GIT_COMMITTER_DATE: `@${atSeconds} +0000`, GIT_AUTHOR_DATE: `@${atSeconds} +0000` }) };
  return execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
const nowS = () => Math.floor(Date.now() / 1000);
/** Commit a change to the checkout with the reflog and committer time `ageSeconds` ago; returns the new HEAD. */
function commit(root: string, file: string, body: string, ageSeconds: number): string {
  writeFileSync(join(root, file), body);
  git(root, ['add', '-A'], nowS() - ageSeconds);
  git(root, ['commit', '-qm', file], nowS() - ageSeconds);
  return git(root, ['rev-parse', 'HEAD']);
}

interface Brain { engine: BrainEngine; home: string; root: string; synced: string }

async function withBrain(databaseUrl: string | undefined, opts: { managed: boolean }, run: (b: Brain) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-truthful-status-'));
  await withEnv({ GBRAIN_HOME: home, GBRAIN_NOTIFIER: '0' }, async () => {
    const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
    try {
      const root = join(home, SOURCE);
      mkdirSync(join(root, 'notes'), { recursive: true });
      git(root, ['init', '-q']);
      const synced = commit(root, 'notes/alice-example.md', '# Alice Example\n', 60 * MINUTE);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw("INSERT INTO sources(id,name,local_path,last_commit,last_sync_at,config) VALUES($1,$1,$2,$3,now(),'{}')", [SOURCE, root, synced]);
      if (opts.managed) {
        await claimWorktree(engine, SOURCE, root);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      }
      await engine.setConfig('sync.on_commit', 'true');
      await run({ engine, home, root, synced });
    } finally {
      await disposePersistenceConsumer(engine).catch(() => undefined);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1').catch(() => undefined);
      await close();
      rmSync(home, { recursive: true, force: true });
    }
  });
}

const doctor = async (engine: BrainEngine) =>
  (await managedSyncLatencyEntry.run({ engine } as unknown as Parameters<typeof managedSyncLatencyEntry.run>[0]) as unknown as Array<Record<string, any>>)[0]!;
const bySource = (check: Record<string, any>) => (check.details?.freshness_by_source ?? []).find((f: { source_id: string }) => f.source_id === SOURCE);
async function markDue(engine: BrainEngine, ageSeconds: number): Promise<void> {
  await engine.executeRaw(`INSERT INTO sync_notifier_sources (source_id, source_incarnation, state, reason, first_due_at, attempts)
    SELECT id, incarnation::text, 'retry', 'notifier_stalled', now() - ($2::int * interval '1 second'), 4 FROM sources WHERE id = $1`, [SOURCE, ageSeconds]);
}

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`truthful sync status (GBRA-133 PR 2b.5) [${backend}]`, () => {
    test('a managed source with an unsynced commit 10 minutes old warns; master read "no samples", ok', () => withBrain(databaseUrl, { managed: true }, async ({ engine, root }) => {
      const head = commit(root, 'notes/bob-example.md', '# Bob Example\n', 10 * MINUTE);
      const check = await doctor(engine);
      expect(check.status).toBe('warn');
      expect(check.message).toContain(`${SOURCE} (waiting 10m`);
      expect(check.message).toContain('dated from the reflog');
      const pending = bySource(check).keyword_visible.oldest_unsynced;
      expect(pending).toMatchObject({ state: 'behind', head, evidence: 'reflog' });
      expect(pending.age_seconds).toBeGreaterThanOrEqual(10 * MINUTE);
      expect(pending.age_seconds).toBeLessThan(11 * MINUTE);
      expect(check.fix?.argv).toEqual(['gbrain', 'sync', 'status', '--source', SOURCE, '--json']);
    }), 120_000);

    test('without a reflog the notifier\'s persisted first_due_at dates the wait: 2 h due fails', () => withBrain(databaseUrl, { managed: true }, async ({ engine, root }) => {
      commit(root, 'notes/bob-example.md', '# Bob Example\n', 5 * MINUTE);
      rmSync(join(root, '.git', 'logs'), { recursive: true, force: true });
      await markDue(engine, 120 * MINUTE);
      const check = await doctor(engine);
      expect(check.status).toBe('fail');
      const pending = bySource(check).keyword_visible.oldest_unsynced;
      expect(pending).toMatchObject({ state: 'behind', evidence: 'first_due_at' });
      expect(pending.age_seconds).toBeGreaterThanOrEqual(120 * MINUTE);
      expect(pending.age_seconds).toBeLessThan(121 * MINUTE);
      expect(check.message).toContain('notifier first_due_at');
    }), 120_000);

    test('with no reflog and no first_due_at the wait reads unknown and warns; a rewritten history says so', () => withBrain(databaseUrl, { managed: true }, async ({ engine, root, synced }) => {
      commit(root, 'notes/bob-example.md', '# Bob Example\n', 5 * MINUTE);
      rmSync(join(root, '.git', 'logs'), { recursive: true, force: true });
      let check = await doctor(engine);
      expect(check.status).toBe('warn');
      expect(bySource(check).keyword_visible.oldest_unsynced).toMatchObject({ state: 'unknown', reason: 'no_reflog', age_seconds: null });
      expect(check.message).toContain('its wait cannot be dated');

      git(root, ['checkout', '-q', '--orphan', 'rewritten']);
      const rewritten = commit(root, 'notes/carol-example.md', '# Carol Example\n', 5 * MINUTE);
      rmSync(join(root, '.git', 'logs'), { recursive: true, force: true });
      expect(rewritten).not.toBe(synced);
      check = await doctor(engine);
      expect(check.status).toBe('warn');
      expect(bySource(check).keyword_visible.oldest_unsynced).toMatchObject({ state: 'unknown', reason: 'history_rewritten' });
    }), 120_000);

    test('keyword-visible and embedded freshness are reported separately; an embedding backlog is reported, not graded', () => withBrain(databaseUrl, { managed: true }, async ({ engine }) => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      const [page] = await engine.executeRaw<{ id: number }>("INSERT INTO pages(source_id,slug,type,title) VALUES($1,'notes/alice-example','note','Alice Example') RETURNING id", [SOURCE]);
      await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision WHERE id=$1', [page!.id]);
      await engine.executeRaw("INSERT INTO content_chunks(page_id,chunk_index,chunk_text,embedding_pending_since) VALUES($1,0,'Alice Example',now() - interval '20 minutes')", [page!.id]);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const check = await doctor(engine);
      expect(check.status).toBe('ok');
      const fresh = bySource(check);
      expect(fresh.keyword_visible.state).toBe('current');
      expect(fresh.embedded.state).toBe('behind');
      expect(fresh.embedded.backlog).toMatchObject({ state: 'behind', pending_chunks: 1 });
      expect(fresh.embedded.backlog.age_seconds).toBeGreaterThanOrEqual(20 * MINUTE);
      expect(fresh.embedded.backlog.age_seconds).toBeLessThan(21 * MINUTE);
    }), 120_000);

    test('classic equivalent: a non-managed brain grades its classic source\'s unsynced commit', () => withBrain(databaseUrl, { managed: false }, async ({ engine, root }) => {
      commit(root, 'notes/bob-example.md', '# Bob Example\n', 10 * MINUTE);
      const check = await doctor(engine);
      expect(check.status).toBe('warn');
      expect(check.message).not.toContain('Not a managed brain');
      expect(bySource(check)).toMatchObject({ kind: 'classic', keyword_visible: { state: 'behind', oldest_unsynced: { evidence: 'reflog' } } });
    }), 120_000);

    const lag = async (engine: BrainEngine, probeContent: boolean) => (await computeAllSourceMetrics(engine, await loadAllSources(engine), { probeContent }))
      .find(m => m.source_id === SOURCE)!.lag_seconds!;

    test('source-health compares HEAD only: an uncommitted edit to a tracked file is not lag', () => withBrain(databaseUrl, { managed: false }, async ({ engine, root }) => {
      writeFileSync(join(root, 'notes/alice-example.md'), '# Alice Example\nan edit not committed yet\n');
      await engine.executeRaw("UPDATE sources SET last_sync_at = now() - interval '1 hour' WHERE id = $1", [SOURCE]);
      expect(await lag(engine, true)).toBe(0);
    }), 120_000);

    test('source-health dates a pending commit from when it landed (reflog), not from the last no-op heartbeat', () => withBrain(databaseUrl, { managed: false }, async ({ engine, root }) => {
      commit(root, 'notes/bob-example.md', '# Bob Example\n', 10 * MINUTE);
      await engine.executeRaw('UPDATE sources SET last_sync_at = now() WHERE id = $1', [SOURCE]);
      const local = await lag(engine, true);
      expect(local).toBeGreaterThanOrEqual(10 * MINUTE);
      expect(local).toBeLessThan(11 * MINUTE);
    }), 120_000);

    test('source-health without git (remote) dates lag from the notifier\'s first_due_at', () => withBrain(databaseUrl, { managed: false }, async ({ engine }) => {
      await engine.executeRaw("UPDATE sources SET newest_content_at = now() - interval '3 hours' WHERE id = $1", [SOURCE]);
      await markDue(engine, 120 * MINUTE);
      const remote = await lag(engine, false);
      expect(remote).toBeGreaterThanOrEqual(120 * MINUTE);
      expect(remote).toBeLessThan(121 * MINUTE);
    }), 120_000);
  });
}
