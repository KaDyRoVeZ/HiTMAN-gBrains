/**
 * #5432 — doctor / bootstrap status checks never report ok for state they did
 * not verify, and never attribute another workspace's push state to this one.
 *
 *   - multi_source_drift: an unreadable source root or subdirectory is
 *     "not verified" (warn), not an empty source; GBRAIN_DRIFT_LIMIT /
 *     GBRAIN_DRIFT_TIMEOUT_MS bound the walk; a failed check is reported.
 *   - onboard embed_staleness: counts with engine.countStaleChunks (the embed
 *     worker's predicate); a failed count warns "not verified".
 *   - bootstrap_push_health / bootstrap status last_push: scoped to the
 *     receipt workspace's own push record.
 *   - subagent_capability: an explicit models.subagent without tool calling
 *     is refused at dispatch, not "falls back".
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { findMisroutedPages } from '../src/core/multi-source-drift.ts';
import { multiSourceDriftCheck, multiSourceDriftNotVerified } from '../src/commands/doctor/schema-pack-checks.ts';
import { checkEmbedStaleness } from '../src/core/onboard/checks.ts';
import { bootstrapDoctorChecks, checkSubagentCapability } from '../src/commands/doctor.ts';
import { statusReport } from '../src/core/bootstrap/status.ts';
import { workspaceRootHash } from '../src/core/workspace-push.ts';
import { withEnv } from './helpers/with-env.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const dirs: string[] = [];
const tmp = (label: string) => {
  const d = mkdtempSync(join(tmpdir(), `gbrain-5432-${label}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) {
    try { chmodSync(d, 0o700); } catch { /* ignore */ }
    rmSync(d, { recursive: true, force: true });
  }
});

describe('#5432 multi_source_drift is not verified when it could not read', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);
  afterAll(async () => {
    await engine.disconnect();
  });

  test('missing root -> root_unreadable; an empty dir is clean', async () => {
    const empty = tmp('empty');
    const result = await findMisroutedPages(engine, [
      { id: 'src-missing', local_path: join(tmpdir(), 'gbrain-5432-does-not-exist') },
      { id: 'src-empty', local_path: empty },
    ]);
    expect(result.unreadable_sources).toEqual([{ source_id: 'src-missing', reason: 'root_unreadable', dirs: 1 }]);
    const check = multiSourceDriftCheck(result, 2, 'local');
    expect(check.status).toBe('warn');
    expect(check.details?.code).toBe('not_verified');
    expect(check.message).toContain('src-missing (root unreadable)');
    expect(check.message).not.toContain('No cross-source slug drift detected.');

    const clean = await findMisroutedPages(engine, [{ id: 'src-empty', local_path: empty }]);
    expect(multiSourceDriftCheck(clean, 1, 'local')).toMatchObject({ status: 'ok', message: 'No cross-source slug drift detected.' });
  });

  test('an unreadable subdirectory is reported, not silently skipped', async () => {
    const root = tmp('subdir');
    mkdirSync(join(root, 'locked'));
    writeFileSync(join(root, 'locked', 'page.md'), 'x\n');
    chmodSync(join(root, 'locked'), 0o000);
    try {
      const result = await findMisroutedPages(engine, [{ id: 'src-locked', local_path: root }]);
      expect(result.unreadable_sources).toEqual([{ source_id: 'src-locked', reason: 'subdirs_unreadable', dirs: 1 }]);
      expect(multiSourceDriftCheck(result, 1, 'remote').status).toBe('warn');
    } finally {
      chmodSync(join(root, 'locked'), 0o700);
    }
  });

  test('GBRAIN_DRIFT_LIMIT bounds the walk when opts do not', async () => {
    const root = tmp('limit');
    for (let i = 0; i < 12; i++) writeFileSync(join(root, `p-${i}.md`), 'x\n');
    const result = await withEnv({ GBRAIN_DRIFT_LIMIT: '5', GBRAIN_DRIFT_TIMEOUT_MS: '4000' },
      () => findMisroutedPages(engine, [{ id: 'src-limit', local_path: root }]));
    expect(result.walk_truncated).toBe(true);
    expect(result.limit).toBe(5);
    expect(result.timeout_ms).toBe(4000);
    const check = multiSourceDriftCheck(result, 1, 'local');
    expect(check.status).toBe('warn');
    expect(check.message).toContain('5 files / 4000 ms');
    expect(check.message).toContain('GBRAIN_DRIFT_LIMIT=<files>');
  });

  test('a failed drift check is reported as not verified', () => {
    const check = multiSourceDriftNotVerified(new Error('relation "sources" does not exist'));
    expect(check).toMatchObject({ name: 'multi_source_drift', status: 'warn' });
    expect(check.details).toMatchObject({ code: 'not_verified', reason: 'relation "sources" does not exist' });
  });
});

describe('#5432 onboard embed_staleness', () => {
  test('counts with the embed worker predicate (countStaleChunks), not raw SQL', async () => {
    const engine = {
      countStaleChunks: async () => 7,
      executeRaw: async () => { throw new Error('raw SQL must not be used'); },
    } as unknown as BrainEngine;
    const r = await checkEmbedStaleness(engine);
    expect(r.check.status).toBe('warn');
    expect(r.check.message).toContain('7 stale chunks');
  });

  test('a failed count warns not verified instead of "No stale chunks"', async () => {
    const engine = {
      countStaleChunks: async () => { throw new Error('permission denied for table content_chunks'); },
      executeRaw: async () => { throw new Error('permission denied for table content_chunks'); },
    } as unknown as BrainEngine;
    const r = await checkEmbedStaleness(engine);
    expect(r.check.status).toBe('warn');
    expect(r.check.message).toContain('Not verified');
    expect(r.check.message).not.toContain('No stale chunks');
    expect(r.check.details).toMatchObject({ code: 'not_verified', reason: 'permission denied for table content_chunks' });
    expect(r.remediations).toEqual([]);
  });
});

describe('#5432 push status is scoped to this workspace', () => {
  const STALE = new Date(Date.now() - 72 * 3600_000).toISOString();
  const FRESH = new Date(Date.now() - 3600_000).toISOString();

  function home(): { parent: string; home: string } {
    const parent = tmp('home');
    const h = join(parent, '.gbrain');
    mkdirSync(join(h, 'bootstrap'), { recursive: true });
    return { parent, home: h };
  }
  function receipt(h: string, ws: string): void {
    writeFileSync(join(h, 'bootstrap', 'receipt.json'), JSON.stringify({
      receipt_version: 1, workspace_dir: ws, source_id: 'workspace', agent_name: 'Testy',
      created_at: new Date().toISOString(), created_by: 'test', brain_created_by_bootstrap: false,
      created_paths: [], registrations: [],
    }));
  }
  function pushStatus(h: string, root: string, body: Record<string, unknown>): void {
    writeFileSync(join(h, 'bootstrap', `push-status-${workspaceRootHash(root)}.json`), JSON.stringify({ ...body, repoRoot: root }));
  }
  function dirtyWorkspace(): string {
    const ws = tmp('ws');
    execFileSync('git', ['init', '-q', ws], { stdio: 'ignore' });
    writeFileSync(join(ws, 'unpushed-note.md'), 'recent agent memory\n');
    return ws;
  }

  test('another root stale + this root fresh and dirty -> never a current-root FAIL', async () => {
    const { parent, home: h } = home();
    const ws = dirtyWorkspace();
    const other = tmp('other-root');
    receipt(h, ws);
    pushStatus(h, ws, { ts: FRESH, ok: true });
    pushStatus(h, other, { ts: STALE, ok: true });
    const checks = await withEnv({ GBRAIN_HOME: parent }, () => bootstrapDoctorChecks(null));
    const c = checks.find((x) => x.name === 'bootstrap_push_health');
    expect(c?.status).toBe('warn');
    expect(c?.message).toContain('2 tracked workspace');
  });

  test('this root stale + dirty -> FAIL naming this root and its own timestamp', async () => {
    const { parent, home: h } = home();
    const ws = dirtyWorkspace();
    const other = tmp('other-root');
    receipt(h, ws);
    pushStatus(h, ws, { ts: STALE, ok: true });
    pushStatus(h, other, { ts: FRESH, ok: true });
    const checks = await withEnv({ GBRAIN_HOME: parent }, () => bootstrapDoctorChecks(null));
    const c = checks.find((x) => x.name === 'bootstrap_push_health');
    expect(c?.status).toBe('fail');
    expect(c?.message).toContain(STALE);
    expect(c?.message).toContain(ws);
  });

  test('bootstrap status last_push reports this root only, both directions', async () => {
    const { parent, home: h } = home();
    const ws = tmp('status-ws');
    const other = tmp('status-other');
    pushStatus(h, ws, { ts: FRESH, ok: true });
    pushStatus(h, other, { ts: FRESH, ok: false, reason: 'remote rejected' });
    const a = await withEnv({ GBRAIN_HOME: parent }, () => statusReport(ws, { gbrainHomeDir: h }));
    expect(a.support.last_push).toEqual({ ts: FRESH, ok: true });

    const { parent: p2, home: h2 } = home();
    pushStatus(h2, other, { ts: FRESH, ok: true });
    const b = await withEnv({ GBRAIN_HOME: p2 }, () => statusReport(ws, { gbrainHomeDir: h2 }));
    expect(b.support.last_push).toBeNull();
  });
});

describe('#5432 subagent_capability no_tools', () => {
  const engineWith = (entries: Record<string, string>) => ({
    getConfig: async (k: string) => entries[k] ?? null,
  }) as unknown as BrainEngine;

  test('explicit models.subagent without tool calling is refused at dispatch, not a fallback', async () => {
    const c = await checkSubagentCapability(engineWith({ 'models.subagent': 'nvidia:nvidia/nemotron-3-super-120b-a12b' }));
    expect(c.status).toBe('warn');
    expect(c.message).toContain('jobs are refused at dispatch');
    expect(c.message).not.toContain('fall back');
  });
});
