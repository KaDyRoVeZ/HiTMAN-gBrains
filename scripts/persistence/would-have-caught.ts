/**
 * "Would-have-caught" measurement for the persistence gate. For every frozen
 * fix in would-have-caught.json, a scratch worktree of HEAD reverse-applies
 * the fix's src/ hunks (tests stay), then runs the gate as it stood before
 * the crash robot (1,000 schedules, eight SIGKILL boundaries, the write soak)
 * and the crash robot phase on its own. A run that fails catches the revert.
 * HEAD itself runs first as the control: both gates must pass there.
 *
 *   bun scripts/persistence/would-have-caught.ts --engine=pglite [--only=<sha>,..] [--jobs=2]
 *     [--operations=2500] [--robot-seconds=300] [--out=.context/would-have-caught-<engine>.json]
 *
 * Postgres needs the gate's DATABASE_URL (and GBRAIN_PGBOUNCER_URL for the pooled route).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

interface Fix { sha: string; date: string; subject: string; src_files: string[] }
interface GateResult { caught: boolean; exit: number; seconds: number; first_failure?: string }
export interface FixResult { sha: string; subject: string; reverted: boolean; current?: GateResult; robot?: GateResult; extended_caught?: boolean; note?: string }

const repo = resolve(import.meta.dir, '../..');
const args = new Map(process.argv.slice(2).map(arg => { const [k, ...v] = arg.replace(/^--/, '').split('='); return [k, v.join('=')]; }));
const engine = args.get('engine') ?? 'pglite';
const operations = Number(args.get('operations') ?? 2500);
const robotSeconds = Number(args.get('robot-seconds') ?? 300);
const jobs = Number(args.get('jobs') ?? 1);
const only = args.get('only')?.split(',').filter(Boolean);
const out = args.get('out') ?? join(repo, '.context', `would-have-caught-${engine}.json`);
const frozen = JSON.parse(readFileSync(join(import.meta.dir, 'would-have-caught.json'), 'utf8')) as { fixes: Fix[] };
const fixes = frozen.fixes.filter(fix => !only || only.some(prefix => fix.sha.startsWith(prefix)));

function git(cwd: string, ...rest: string[]) { return spawnSync('git', ['-C', cwd, ...rest], { encoding: 'utf8' }); }

function worktree(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `gbrain-whc-${label}-`));
  rmSync(dir, { recursive: true });
  const added = git(repo, 'worktree', 'add', '--detach', dir, 'HEAD');
  if (added.status) throw new Error(`git worktree add failed: ${added.stderr}`);
  symlinkSync(join(repo, 'node_modules'), join(dir, 'node_modules'));
  return dir;
}

async function gate(dir: string, kind: 'current' | 'robot', label: string): Promise<GateResult> {
  const manifest = join(dir, '.context', `${kind}.json`); mkdirSync(join(dir, '.context'), { recursive: true });
  const flags = kind === 'current' ? [`--operations=${operations}`, '--robot-seconds=0']
    : ['--schedules=0', '--operations=0', '--no-crashes', `--robot-seconds=${robotSeconds}`];
  const started = performance.now();
  const child = Bun.spawn([process.execPath, '--no-env-file', 'scripts/persistence/validate.ts', `--engine=${engine}`, ...flags, `--manifest=${manifest}`],
    { cwd: dir, stdout: 'ignore', stderr: 'pipe', env: process.env });
  const stderr = await new Response(child.stderr).text();
  const exit = await child.exited;
  const seconds = (performance.now() - started) / 1000;
  let firstFailure: string | undefined;
  if (exit !== 0) {
    try { firstFailure = String(JSON.parse(readFileSync(manifest, 'utf8')).failure ?? '').split('\n').slice(0, 3).join(' | ').slice(0, 600); }
    catch { firstFailure = stderr.split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 600); }
  }
  process.stderr.write(`[would-have-caught] ${engine} ${label} ${kind}: ${exit === 0 ? 'passed' : 'FAILED'} (${seconds.toFixed(0)} s)\n`);
  return { caught: exit !== 0, exit, seconds, ...(firstFailure ? { first_failure: firstFailure } : {}) };
}

async function measure(fix: Fix | null): Promise<FixResult> {
  const label = fix ? fix.sha.slice(0, 9) : 'control';
  const dir = worktree(label);
  try {
    if (fix) {
      const diff = git(repo, 'diff', `${fix.sha}^`, fix.sha, '--', 'src');
      const apply = spawnSync('git', ['-C', dir, 'apply', '-R', '-3'], { input: diff.stdout, encoding: 'utf8' });
      if (apply.status) return { sha: fix.sha, subject: fix.subject, reverted: false, note: apply.stderr.slice(0, 300) };
    }
    const [current, robot] = [await gate(dir, 'current', label), await gate(dir, 'robot', label)];
    return { sha: fix?.sha ?? 'HEAD', subject: fix?.subject ?? 'control (no revert)', reverted: !!fix, current, robot,
      extended_caught: current.caught || robot.caught };
  } finally {
    git(repo, 'worktree', 'remove', '--force', dir);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

// The control runs alone first: a gate that fails without any revert measures nothing.
const control = await measure(null);
if (control.current?.caught || control.robot?.caught) {
  process.stderr.write(`[would-have-caught] control failed on HEAD; fix the gate or its environment first: ${control.current?.first_failure ?? control.robot?.first_failure}\n`);
  process.exit(2);
}
const queue: Fix[] = [...fixes];
const results: FixResult[] = [control];
await Promise.all(Array.from({ length: Math.max(1, jobs) }, async () => {
  for (;;) { const next = queue.shift(); if (next === undefined) return; results.push(await measure(next)); }
}));
const measured = results.filter(r => r.reverted);
const summary = {
  engine, operations, robot_seconds: robotSeconds, head: git(repo, 'rev-parse', 'HEAD').stdout.trim(),
  control: results.find(r => !r.reverted && r.sha === 'HEAD'),
  fixes: measured.length, not_reverted: results.filter(r => r.reverted === false && r.sha !== 'HEAD').map(r => r.sha),
  current_caught: measured.filter(r => r.current?.caught).length,
  extended_caught: measured.filter(r => r.extended_caught).length,
  marginal: measured.filter(r => r.extended_caught && !r.current?.caught).map(r => r.sha.slice(0, 9)),
  results: results.sort((a, b) => a.sha.localeCompare(b.sha)),
};
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ ...summary, results: undefined }, null, 2)}\n`);
