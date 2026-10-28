/**
 * Engine graduation state machine and run custody.
 *
 * Protects: the transition tables drive every manifest/row change (an illegal
 * transition throws); manifest v3 is 0600 and never leaks the password; the
 * run reaches exactly one authoritative engine from a fresh start and after a
 * crash at every custody seam; the target fence refuses every writer but the
 * run; a source change during a lock gap reaches the target; a stray
 * datastore at the old path is split brain with the target withheld;
 * refusals before the fence leave the source writable; --status mutates
 * nothing. Regressions that fail it: a resume that trusts current routing, a
 * cutover that grants authority before the tombstone, a fence that admits
 * unidentified sessions, a lock gap that skips the re-check.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertTransition, GRADUATION_RUN_BOUNDARIES, MANIFEST_STATES, MANIFEST_TRANSITIONS, SOURCE_ROW_STATES, SOURCE_TRANSITIONS, TARGET_ROW_STATES, TARGET_TRANSITIONS,
  type GraduationManifest, type ManifestState,
} from '../src/core/persistence/engine-graduation.types.ts';
import {
  graduationStatus, planGraduation, readGraduationManifest, redactManifest, resumeGraduation, runGraduation, transitionManifest,
  writeGraduationManifest, type GraduationOptions,
} from '../src/core/persistence/engine-graduation.ts';
import { assertGraduationAdmission, assertGraduationConnectAllowed, graduatedPath, readIntentMarker, readTombstone } from '../src/core/persistence/graduation-custody.ts';
import { graduationFenceStatus, readGraduationRow, setSourceState, setTargetState, withGraduationRun } from '../src/core/persistence/graduation-schema.ts';
import { LiveServeLockError } from '../src/core/pglite-lock.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { crashAt, makeHarness, openPglite, probeRows, TARGET_URL, type Harness } from './helpers/graduation-harness.ts';

/** Another process opening the datastore (a respawned serve): its refusal code, or 'opened'. */
function openInChild(dataDir: string): string {
  const script = `import { PGLiteEngine } from ${JSON.stringify(join(import.meta.dir, '../src/core/pglite-engine.ts'))};
const Engine = PGLiteEngine;
const e = new Engine();
try { await e.connect({ engine: 'pglite', database_path: ${JSON.stringify(dataDir)} }); console.log('opened'); await e.disconnect(); }
catch (err) { console.log(err?.code ?? String(err)); }`;
  const child = Bun.spawnSync([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  return child.stdout.toString().trim().split('\n').pop() ?? '';
}

function codeOf(error: unknown): string | undefined { return (error as { code?: string })?.code; }
async function refusal(promise: Promise<unknown>): Promise<{ code?: string; fix?: { argv?: string[]; plan_hash?: string }; message: string }> {
  try { await promise; } catch (error) { return { code: codeOf(error), fix: (error as { fix?: { argv?: string[] } }).fix, message: (error as Error).message }; }
  throw new Error('expected a refusal');
}

describe('transition tables', () => {
  const tables = [
    ['manifest', MANIFEST_STATES, MANIFEST_TRANSITIONS],
    ['target', TARGET_ROW_STATES, TARGET_TRANSITIONS],
    ['source', SOURCE_ROW_STATES, SOURCE_TRANSITIONS],
  ] as const;
  for (const [name, states, table] of tables) {
    test(`${name}: assertTransition admits exactly the listed transitions`, () => {
      for (const from of states) {
        for (const to of states) {
          const allowed = (table as Record<string, readonly string[]>)[from]!.includes(to);
          const attempt = () => assertTransition(table as Record<string, readonly string[]>, from, to);
          if (allowed) expect(attempt).not.toThrow(); else expect(attempt).toThrow(/Illegal graduation transition/);
        }
      }
    });
  }
  test('every manifest state is reachable from planned, and terminal states have no exit', () => {
    const seen = new Set<string>(['planned']);
    const queue: string[] = ['planned'];
    while (queue.length) for (const next of MANIFEST_TRANSITIONS[queue.shift() as ManifestState]) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    expect([...seen].sort()).toEqual([...MANIFEST_STATES].sort());
    expect(MANIFEST_TRANSITIONS.rolled_back).toEqual([]);
    expect(MANIFEST_TRANSITIONS.abandoned).toEqual([]);
    expect(MANIFEST_TRANSITIONS.rollback_approved).toEqual(['source_restoring']);
  });
});

describe('manifest v3', () => {
  let h: Harness;
  beforeAll(async () => { h = await makeHarness(); });
  afterAll(async () => { await h.close(); });

  test('written 0600 atomically, round-trips, redaction drops the URLs, illegal transitions throw', () => {
    const path = join(h.root, 'manifest-check.json');
    const m: GraduationManifest = {
      version: 3, runId: 'r', state: 'planned', source: { dataDir: h.dataDir, brainId: '', hostId: '' },
      target: { id: 'x', host: 'h', port: 5432, database: 'd', user: 'u' }, routes: { main: 'postgres://u@h:5432/d', ddl: 'postgres://u@h:5432/d' },
      inventoryVersion: 1, schemaVersion: 1, planHash: 'p', triggerBypass: 'session_replication_role', tables: [], timings: {},
      startedAt: '', updatedAt: '', targetUrls: { main: TARGET_URL, ddl: TARGET_URL },
    };
    writeGraduationManifest(m, path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readGraduationManifest(path)).toEqual(m);
    expect(JSON.stringify(redactManifest(m))).not.toContain('secret-pw');
    expect(() => transitionManifest(m, 'cutover')).toThrow(/planned -> cutover/);
    transitionManifest(m, 'quiesced');
    expect(m.state).toBe('quiesced');
  });
});

describe('row state machine, connect and admission checks', () => {
  let h: Harness;
  beforeAll(async () => { h = await makeHarness(); await h.target.initSchema(); });
  afterAll(async () => { await h.close(); });

  test('target row transitions follow TARGET_TRANSITIONS; connect and admission refuse until authority', async () => {
    const run = crypto.randomUUID();
    const t = h.target;
    await expect(withGraduationRun(t, run, tx => setTargetState(tx, run, 'verified'))).rejects.toThrow(/\(none\) -> verified/);
    await withGraduationRun(t, run, tx => setTargetState(tx, run, 'copying'));
    await expect(withGraduationRun(t, run, tx => setTargetState(tx, run, 'authoritative'))).rejects.toThrow(/copying -> authoritative/);
    expect(codeOf(await assertGraduationConnectAllowed(t, {}).catch(e => e))).toBe('graduation_in_progress');
    await expect(assertGraduationConnectAllowed(t, { GBRAIN_GRADUATION_RUN: run })).resolves.toBeUndefined();
    expect(codeOf(await t.transaction(tx => assertGraduationAdmission(tx)).catch(e => e))).toBe('graduation_in_progress');
    await expect(withGraduationRun(t, run, tx => assertGraduationAdmission(tx))).resolves.toBeUndefined();
    await expect(withGraduationRun(t, crypto.randomUUID(), tx => setTargetState(tx, crypto.randomUUID(), 'copying'))).rejects.toThrow(/belongs to graduation run/);
    await withGraduationRun(t, run, async tx => { await setTargetState(tx, run, 'verifying'); await setTargetState(tx, run, 'verified'); await setTargetState(tx, run, 'authoritative'); });
    await expect(assertGraduationConnectAllowed(t, {})).resolves.toBeUndefined();
    await expect(t.transaction(tx => assertGraduationAdmission(tx))).resolves.toBeUndefined();
  }, 60_000);

  test('a source row at cutover refuses: interrupted before the tombstone exists', async () => {
    const source = await openPglite(join(h.root, 'cutover-source.pglite'));
    try {
      await source.initSchema();
      const run = crypto.randomUUID();
      await withGraduationRun(source, run, tx => setSourceState(tx, run, 'quiesced', { sourceDataDir: join(h.root, 'cutover-source.pglite') }));
      await expect(assertGraduationConnectAllowed(source, {})).resolves.toBeUndefined();
      await withGraduationRun(source, run, tx => setSourceState(tx, run, 'cutover'));
      expect(codeOf(await assertGraduationConnectAllowed(source, {}).catch(e => e))).toBe('graduation_interrupted');
      expect(codeOf(await source.transaction(tx => assertGraduationAdmission(tx)).catch(e => e))).toBe('graduation_interrupted');
      await expect(withGraduationRun(source, run, tx => setSourceState(tx, run, 'quiesced'))).resolves.toBeUndefined();
    } finally { await source.disconnect(); }
  }, 60_000);
});

const POSTGRES_URL = process.env.DATABASE_URL;
const targets: Array<[string, string | undefined]> = [['pglite target', undefined]];
if (POSTGRES_URL) { assertSafeE2eDatabaseUrl(POSTGRES_URL); targets.push(['postgres target', POSTGRES_URL]); }

for (const [label, postgresUrl] of targets) {
  describe(`graduation run (${label})`, () => {
    let h: Harness;
    beforeAll(async () => { h = await makeHarness({ postgresUrl }); });
    afterAll(async () => { await h.close(); });

    async function fresh(): Promise<void> { await h.close(); h = await makeHarness({ postgresUrl }); }
    function runOpts(expect: string, extra: Partial<GraduationOptions> = {}): GraduationOptions {
      return { config: { engine: 'pglite', database_path: h.dataDir } as GraduationOptions['config'], to: 'postgres', url: TARGET_URL, env: {}, drainTimeoutMs: 60_000,
        force: false, yes: true, expectPlanHash: expect, deps: h.deps, handoffTimeoutMs: 1_000, ...extra };
    }
    async function plan(extra: Partial<GraduationOptions> = {}): Promise<string> {
      return (await planGraduation(runOpts('', { yes: false, ...extra }))).planHash;
    }
    async function assertGraduated(): Promise<void> {
      const config = JSON.parse(readFileSync(join(h.gbrainDir, 'config.json'), 'utf8'));
      expect(config.engine).toBe('postgres');
      expect(config.database_url).toBe(TARGET_URL);
      expect(config.database_path).toBeUndefined();
      expect(lstatSync(h.dataDir).isFile()).toBe(true);
      const tombstone = readTombstone(h.dataDir)!;
      expect(JSON.stringify(tombstone)).not.toContain('secret-pw');
      expect(existsSync(tombstone.movedTo)).toBe(true);
      const row = await readGraduationRow(h.target);
      expect(row?.state).toBe('authoritative');
      expect((await graduationFenceStatus(h.target)).fenced).toBe(0);
      expect((await probeRows(h.target)).map(r => r.v)).toEqual(['alpha', 'beta', 'gamma']);
      const manifest = readGraduationManifest(join(h.gbrainDir, 'graduation-manifest.json'))!;
      expect(manifest.state).toBe('graduated');
      expect(statSync(join(h.gbrainDir, 'graduation-manifest.json')).mode & 0o777).toBe(0o600);
      const mounts = JSON.parse(readFileSync(h.mountsPath, 'utf8'));
      expect(mounts.mounts[0]).toMatchObject({ id: 'team-example', engine: 'postgres', database_url: TARGET_URL });
      expect(mounts.mounts[0].database_path).toBeUndefined();
      const reopen = await openPglite(h.dataDir).catch(e => e);
      expect(codeOf(reopen)).toBe('engine_graduated');
      expect(lstatSync(h.dataDir).isFile()).toBe(true);
    }

    test('plan -> run reaches one authoritative engine; the source path is a tombstone', async () => {
      await h.inHome(async () => {
        const hash = await plan();
        const receipt = await runGraduation(runOpts(hash));
        expect(receipt.state).toBe('authoritative');
        expect(receipt.triggerBypass).toBe('session_replication_role');
        await assertGraduated();
        const moved = readTombstone(h.dataDir)!.movedTo;
        const retained = await openPglite(moved);
        try { expect((await readGraduationRow(retained))?.state).toBe('cutover'); } finally { await retained.disconnect(); }
        expect(h.calls.pause_released).toBe(1);
      });
    }, 60_000);

    test('the fence refuses other writers while the copy runs; the run itself writes', async () => {
      await fresh();
      await h.inHome(async () => {
        let observed: { write?: string; exempt?: boolean; respawn?: string } = {};
        const hash = await plan();
        await runGraduation(runOpts(hash, { pauseAt: 'table_copied', pauseHook: async () => {
          const run = readGraduationManifest(join(h.gbrainDir, 'graduation-manifest.json'))!.runId;
          observed = {
            ...observed,
            write: await h.target.executeRaw(`INSERT INTO config (key, value) VALUES ('stray', 'x')`).then(() => 'accepted', (e: Error) => e.message.split(':')[0]),
            exempt: await assertGraduationConnectAllowed(h.target, { GBRAIN_GRADUATION_RUN: run }).then(() => true),
          };
          const marker = readIntentMarker(h.dataDir)!;
          expect(marker.state).toBe('copying');
          observed.respawn = openInChild(h.dataDir);
        } }));
        expect(observed).toEqual({ write: 'graduation_in_progress', exempt: true, respawn: 'graduation_in_progress' });
        await assertGraduated();
      });
    }, 60_000);

    const seams = GRADUATION_RUN_BOUNDARIES.filter(b => b !== 'batch_copied' && b !== 'graduated');
    for (const seam of seams) {
      test(`a crash at ${seam} resumes to exactly one authoritative engine`, async () => {
        await fresh();
        await h.inHome(async () => {
          const hash = await plan();
          await expect(runGraduation(runOpts(hash, { pauseAt: seam, pauseHook: crashAt(seam) }))).rejects.toThrow(`simulated crash at ${seam}`);
          const status = await graduationStatus({ deps: h.deps });
          expect(status.liveRun).toBeNull();
          expect(status.nextArgv).toEqual(['gbrain', 'migrate', '--resume']);
          const row = await readGraduationRow(h.target);
          if (row) expect(row.state === 'authoritative' ? seam : 'non-authoritative').toBe(['authoritative', 'config_flipped', 'registry_rewritten'].includes(seam) ? seam : 'non-authoritative');
          await resumeGraduation({ env: {}, deps: h.deps, handoffTimeoutMs: 1_000 });
          await assertGraduated();
        });
      }, 60_000);
    }

    test('a source write during a lock gap after verify reaches the target', async () => {
      await fresh();
      await h.inHome(async () => {
        const hash = await plan();
        await expect(runGraduation(runOpts(hash, { pauseAt: 'verified', pauseHook: crashAt('verified') }))).rejects.toThrow();
        const copiesBefore = h.calls.copy_probe ?? 0;
        const source = await openPglite(h.dataDir);
        try { await source.executeRaw(`INSERT INTO grad_probe VALUES (4, 'written-in-gap')`); } finally { await source.disconnect(); }
        await resumeGraduation({ env: {}, deps: h.deps, handoffTimeoutMs: 1_000 });
        expect(h.calls.copy_probe).toBe(copiesBefore + 1);
        expect((await probeRows(h.target)).map(r => r.v)).toContain('written-in-gap');
      });
    }, 60_000);

    test('a stray datastore at the old path is split brain; the target stays non-authoritative', async () => {
      await fresh();
      await h.inHome(async () => {
        const hash = await plan();
        await expect(runGraduation(runOpts(hash, { pauseAt: 'moved_aside', pauseHook: crashAt('moved_aside') }))).rejects.toThrow();
        mkdirSync(h.dataDir);
        const refused = await refusal(resumeGraduation({ env: {}, deps: h.deps, handoffTimeoutMs: 1_000 }));
        expect(refused.code).toBe('graduation_split_brain');
        expect(refused.fix?.argv).toEqual(['gbrain', 'migrate', '--resume', '--yes']);
        expect((await readGraduationRow(h.target))?.state).toBe('verified');
        const status = await graduationStatus({ deps: h.deps });
        expect(status.sourcePath?.state).toBe('split_brain');
        expect(status.splitBrain?.map(side => side.path)).toEqual([h.dataDir, `${h.dataDir}.graduated-${status.runId}`]);
        await resumeGraduation({ env: {}, deps: h.deps, handoffTimeoutMs: 1_000, yes: true });
        expect(existsSync(`${h.dataDir}.stray-${status.runId}`)).toBe(true);
        await assertGraduated();
      });
    }, 60_000);

    test('a path occupied when the live run creates the tombstone refuses as split brain', async () => {
      await fresh();
      await h.inHome(async () => {
        const hash = await plan();
        const refused = await refusal(runGraduation(runOpts(hash, { pauseAt: 'moved_aside', pauseHook: async () => { mkdirSync(h.dataDir); } })));
        expect(refused.code).toBe('graduation_split_brain');
        expect((await readGraduationRow(h.target))?.state).toBe('verified');
        expect((await graduationFenceStatus(h.target)).unfenced).toEqual([]);
      });
    }, 60_000);

    test('a changed plan refuses before anything is fenced and leaves the source writable', async () => {
      await fresh();
      await h.inHome(async () => {
        const refused = await refusal(runGraduation(runOpts('0000000000000000')));
        expect(refused.code).toBe('preview_changed');
        expect(readIntentMarker(h.dataDir)).toBeNull();
        expect(readGraduationManifest(join(h.gbrainDir, 'graduation-manifest.json'))?.state).toBe('abandoned');
        const source = await openPglite(h.dataDir);
        try { await source.executeRaw(`INSERT INTO grad_probe VALUES (9, 'still-writable')`); } finally { await source.disconnect(); }
        expect(await readGraduationRow(h.target)).toBeNull();
      });
    }, 60_000);

    test('a live serve that never hands off refuses with the two-step writer-held fix; one that does is waited for', async () => {
      await fresh();
      await h.inHome(async () => {
        const hash = await plan();
        const held = { ...h.deps, openSource: async () => { throw new LiveServeLockError('held by serve', { pid: 424242, transport: 'stdio' }); } };
        const refused = await refusal(runGraduation(runOpts(hash, { deps: held, handoffTimeoutMs: 300 })));
        expect(refused.code).toBe('graduation_source_writer_held');
        expect(refused.fix?.argv).toEqual(['kill', '424242']);
        expect(readIntentMarker(h.dataDir)).toBeNull();
        let refusals = 2;
        const { defaultGraduationDeps } = await import('../src/core/persistence/engine-graduation.ts');
        const real = defaultGraduationDeps();
        const handOff = { ...h.deps, openSource: async (dir: string, o: { migrate: boolean }) => {
          if (refusals-- > 0) throw new LiveServeLockError('held by serve', { pid: 424242, transport: 'stdio' });
          return real.openSource.call(real, dir, o);
        } };
        await runGraduation(runOpts(hash, { deps: handOff, handoffTimeoutMs: 5_000 }));
        await assertGraduated();
      });
    }, 60_000);

    test('a drain timeout and a verify failure are resumable; the source stays writable in between', async () => {
      await fresh();
      await h.inHome(async () => {
        const hash = await plan();
        const stuck = { ...h.deps, drainForGraduation: async () => ({ drained: [], blockers: [{ kind: 'request' as const, id: 'req-1', detail: 'running', needsUser: false }] }) };
        const timeout = await refusal(runGraduation(runOpts(hash, { deps: stuck, drainTimeoutMs: 60_000 })));
        expect(timeout.code).toBe('graduation_drain_timeout');
        expect(timeout.fix?.argv).toEqual(['gbrain', 'migrate', '--resume', '--drain-timeout', '120']);
        expect(readGraduationManifest(join(h.gbrainDir, 'graduation-manifest.json'))?.state).toBe('draining');
        const failing = { ...h.deps, verifyGraduation: async () => ({ ok: false, tables: [], failures: [{ relation: 'grad_probe', kind: 'digest' as const, detail: 'mismatch' }], replay: { status: 'not_available' as const, reason: 'no_caller_input' as const }, doctorFailingChecks: [] }) };
        const failed = await refusal(resumeGraduation({ env: {}, deps: failing, handoffTimeoutMs: 1_000 }));
        expect(failed.code).toBe('graduation_verify_failed');
        expect((await readGraduationRow(h.target))?.state).toBe('verify_failed');
        const source = await openPglite(h.dataDir);
        try { await source.executeRaw(`INSERT INTO grad_probe VALUES (5, 'after-verify-failure')`); } finally { await source.disconnect(); }
        await resumeGraduation({ env: {}, deps: h.deps, handoffTimeoutMs: 1_000 });
        expect((await probeRows(h.target)).map(r => r.v)).toContain('after-verify-failure');
        expect(lstatSync(h.dataDir).isFile()).toBe(true);
      });
    }, 60_000);

    test('--status performs zero mutations at a crash point', async () => {
      await fresh();
      await h.inHome(async () => {
        const hash = await plan();
        await expect(runGraduation(runOpts(hash, { pauseAt: 'source_cutover', pauseHook: crashAt('source_cutover') }))).rejects.toThrow();
        const files = [join(h.gbrainDir, 'graduation-manifest.json'), `${h.dataDir}.gbrain-graduation.json`, join(h.gbrainDir, 'config.json')];
        const before = files.map(f => [readFileSync(f, 'utf8'), statSync(f).mtimeMs]);
        const status = await graduationStatus({ deps: h.deps });
        expect(status.state).toBe('cutover');
        expect(status.sourcePath?.state).toBe('interrupted');
        expect(status.target?.row).toBe('verified');
        expect(JSON.stringify(status)).not.toContain('secret-pw');
        expect(files.map(f => [readFileSync(f, 'utf8'), statSync(f).mtimeMs])).toEqual(before);
        expect(existsSync(graduatedPath(h.dataDir, status.runId!))).toBe(false);
      });
    }, 60_000);
  });
}
