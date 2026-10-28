/**
 * Scenario steps shared by the graduation E2E suites: a fresh legacy fixture
 * with an empty target, the authority invariant ("at most one engine accepts
 * writes"), the graduated end state, and the agent-style rollback flow.
 */
import { expect } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from '#postgres';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { admitWrite } from '../../src/core/persistence/journal.ts';
import { prepareGraduationFixture, type GraduationFixture } from '../../scripts/persistence/graduation-fixture.ts';
import { legacyTargetMismatches, readQueuedAdmission, snapshotLegacySource, type LegacySourceSnapshot } from '../fixtures/graduation/legacy-brain.ts';
import { withEnv } from './with-env.ts';
import {
  custodyPaths, emptyTarget, gbrain, manifestPath, planHashOf, stateOf, TARGET_ENV, type GbrainOpts, type GbrainResult, type TargetDb,
} from './graduation-e2e.ts';

export const scratchRoot = mkdtempSync(join(tmpdir(), 'gbrain-graduation-e2e-'));
const cacheDir = process.env.GBRAIN_GRADUATION_FIXTURE_CACHE || join(scratchRoot, 'fixture-cache');
let counter = 0;

export interface Case { fx: GraduationFixture; target: TargetDb; before: LegacySourceSnapshot; events: string }

/** A restored legacy fixture, its pre-graduation snapshot and an empty target database. */
export async function legacyCase(name: string, target?: TargetDb): Promise<Case> {
  const fx = await prepareGraduationFixture({ kind: 'legacy', dir: join(scratchRoot, `${name}-${++counter}`), cacheDir });
  const before = await withSource(fx, engine => snapshotLegacySource(engine));
  return { fx, target: target ?? await emptyTarget(), before, events: join(fx.dir, 'boundary-events.jsonl') };
}

export async function historyCase(name: string, pages: number, seed = 1): Promise<{ fx: GraduationFixture; target: TargetDb }> {
  const fx = await prepareGraduationFixture({ kind: 'history', pages, seed, dir: join(scratchRoot, `${name}-${++counter}`), cacheDir, timeoutMs: 45 * 60_000 });
  return { fx, target: await emptyTarget() };
}

/** Open the fixture's PGLite source in-process (only while no graduation process holds it). */
export async function withSource<T>(fx: GraduationFixture, fn: (engine: PGLiteEngine) => Promise<T>, dataDir = fx.dataDir): Promise<T> {
  return withEnv({ GBRAIN_HOME: fx.home, HOME: fx.home }, async () => {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir });
    try { return await fn(engine); } finally { await engine.disconnect(); }
  });
}

export async function withTarget<T>(url: string, fn: (engine: PostgresEngine) => Promise<T>): Promise<T> {
  const engine = new PostgresEngine();
  await engine.connect({ database_url: url, poolSize: 2 });
  try { return await fn(engine); } finally { await engine.disconnect(); }
}

/** The target's persistence_graduation row state, or null (no table, no row, or no database). */
export async function targetRowState(url: string): Promise<string | null> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const rows = await sql.unsafe<{ state: string }[]>(`SELECT state FROM persistence_graduation LIMIT 1`);
    return rows[0]?.state ?? null;
  } catch { return null; } finally { await sql.end(); }
}

export async function targetFenceTriggers(url: string): Promise<number> {
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const [row] = await sql.unsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname LIKE 'gbrain_graduation_fence%'`);
    return Number(row.n);
  } catch { return 0; } finally { await sql.end(); }
}

/** Engine routing recorded in the fixture's config.json. */
export function configuredEngine(fx: GraduationFixture): { engine: string; database_path?: string; database_url?: string } {
  return JSON.parse(readFileSync(join(fx.home, '.gbrain', 'config.json'), 'utf8'));
}

/**
 * Which engines could accept a write right now, read without writing:
 * the target only when its row is `authoritative` with no fence; the source
 * only when its data dir is a directory whose source row is not `cutover` and
 * no graduation intent marker stands in front of it.
 */
export async function authority(c: Case): Promise<{ source: boolean; target: boolean; targetState: string | null; sourceState: string | null }> {
  const targetState = await targetRowState(c.target.url);
  const target = targetState === 'authoritative' && await targetFenceTriggers(c.target.url) === 0;
  const paths = custodyPaths(c.fx.dataDir);
  let sourceState: string | null = null;
  if (paths.dataDirIsDirectory) {
    // A source fenced past cutover refuses to open at all (graduation_interrupted until resume): it is not a writer.
    sourceState = await withSource(c.fx, async engine => {
      try { return (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_graduation LIMIT 1'))[0]?.state ?? null; }
      catch { return null; }
    }).catch(error => {
      const code = (error as { code?: string }).code;
      if (code === 'graduation_interrupted' || code === 'graduation_in_progress' || code === 'engine_graduated') return 'cutover';
      throw error;
    });
  }
  const source = paths.dataDirIsDirectory && sourceState !== 'cutover' && !existsSync(paths.marker);
  return { source, target, targetState, sourceState };
}

export async function expectAtMostOneWriter(c: Case, label: string): Promise<void> {
  const a = await authority(c);
  expect({ label, both: a.source && a.target }).toEqual({ label, both: false });
}

export function failingChecks(doc: Record<string, any> | null): string[] {
  // The run document's `doctor` is { source, target } lists of failing check names; doctor --json has `checks`.
  if (Array.isArray(doc?.target)) return doc.target as string[];
  return ((doc?.checks ?? []) as { name: string; status: string }[]).filter(c => c.status === 'fail').map(c => c.name);
}

export async function doctorFailures(home: string): Promise<{ result: GbrainResult; failing: string[] }> {
  const result = await gbrain(['doctor', '--no-migrate', '--json'], { home, timeoutMs: 300_000 });
  return { result, failing: failingChecks(result.json) };
}

/**
 * The graduated end state: routing on the target, the source tombstoned with
 * its retained copy, the target authoritative without fence triggers, every
 * expected.json target expectation, one row per request id, a replay of the
 * queued request returning the stored outcome, and a green target doctor.
 */
export async function expectGraduated(c: Case, label: string, opts: { liveWork?: boolean } = {}): Promise<void> {
  const status = await gbrain(['migrate', '--status', '--json'], { home: c.fx.home });
  expect({ label, code: status.code, state: stateOf(status.json) }).toEqual({ label, code: 0, state: 'graduated' });
  expect(configuredEngine(c.fx).engine).toBe('postgres');
  const paths = custodyPaths(c.fx.dataDir);
  expect({ label, tombstone: paths.tombstone !== null, retained: paths.graduated.length }).toEqual({ label, tombstone: true, retained: 1 });
  expect(statSync(c.fx.dataDir).mode & 0o777).toBe(0o600);
  expect(await targetRowState(c.target.url)).toBe('authoritative');
  expect(await targetFenceTriggers(c.target.url)).toBe(0);
  await withTarget(c.target.url, async target => {
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(target) });
    // A resident serve that owned the source before the hand-off legitimately finished queued effects and projection jobs.
    const mismatches = (await legacyTargetMismatches(target, c.before, token => provider.verifyAccessToken(token)))
      .filter(m => !(opts.liveWork && (m.startsWith('target effect ') || m.startsWith('target projection job '))));
    expect({ label, mismatches }).toEqual({ label, mismatches: [] });
    const duplicates = await target.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM (SELECT principal_kind,principal_id,request_id
      FROM persistence_requests GROUP BY 1,2,3 HAVING count(*) > 1) d`);
    expect(Number(duplicates[0].n)).toBe(0);
    await expectReplayReturnsStored(target, c.fx);
  });
  const doctor = await doctorFailures(c.fx.home);
  expect({ label, failing: doctor.failing }).toEqual({ label, failing: [] });
}

/** Resubmit the queued request (recorded with its callerIntent) on the target: stored outcome back, no new row, counters unchanged. */
export async function expectReplayReturnsStored(target: PostgresEngine, fx: GraduationFixture): Promise<void> {
  const admission = readQueuedAdmission(fx.root);
  const counters = async () => (await target.executeRaw<Record<string, unknown>>('SELECT * FROM persistence_counters ORDER BY key COLLATE "C"')).map(r => JSON.stringify(r, (_k, v) => typeof v === 'bigint' ? v.toString() : v));
  const rows = async () => Number((await target.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests'))[0].n);
  const [stored] = await target.executeRaw<{ id: string; state: string; outcome: Record<string, unknown> | null }>(
    'SELECT id::text AS id,state,outcome FROM persistence_requests WHERE request_id=$1::uuid', [admission.requestId]);
  expect(stored?.state).toBe('committed');
  const beforeRows = await rows(); const beforeCounters = await counters();
  const replay = await withEnv({ GBRAIN_HOME: fx.home, HOME: fx.home }, () => admitWrite(target, admission));
  expect({ id: replay.id, state: replay.state, outcome: replay.outcome }).toEqual({ id: stored.id, state: 'committed', outcome: stored.outcome });
  expect(await rows()).toBe(beforeRows);
  expect(await counters()).toEqual(beforeCounters);
}

/** Run the plan, then the confirmed run, the way an agent would. */
export async function planAndRun(c: Case, opts: { extra?: string[]; env?: Record<string, string>; hooks?: GbrainOpts['hooks']; url?: string } = {}) {
  const env = { [TARGET_ENV]: opts.url ?? c.target.url, ...opts.env };
  const plan = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--plan', '--json', ...(opts.extra ?? [])], { home: c.fx.home, env });
  expect({ code: plan.code, stderr: plan.code === 0 ? '' : plan.stderr.slice(-2000) }).toEqual({ code: 0, stderr: '' });
  const hash = planHashOf(plan.json);
  expect(typeof hash).toBe('string');
  return { plan, hash: hash!, env, argv: ['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--yes', '--expect', hash!, '--json', ...(opts.extra ?? [])] };
}

/** `--rollback-to-source`, confirming once with the hash when the CLI asks (exit 3). */
export async function rollback(c: Case, opts: { hooks?: GbrainOpts['hooks']; confirm?: boolean } = {}): Promise<{ first: GbrainResult; confirmed: GbrainResult | null }> {
  const first = await gbrain(['migrate', '--rollback-to-source', '--json'], { home: c.fx.home, hooks: opts.hooks });
  if (first.code !== 3 || opts.confirm === false) return { first, confirmed: null };
  const hash = planHashOf(first.json);
  const confirmed = await gbrain(['migrate', '--rollback-to-source', '--yes', '--expect', String(hash), '--json'], { home: c.fx.home, hooks: opts.hooks });
  return { first, confirmed };
}

export function manifestState(fx: GraduationFixture): string | null {
  const path = manifestPath(fx.home);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).state ?? null : null;
}
