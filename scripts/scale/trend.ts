#!/usr/bin/env bun
/**
 * Scale-tier trend reader (F4c; O-CEO-9 / O-CEO-16). Read-only.
 *
 *   bun scripts/scale/trend.ts [--runs 5] [--dir <reports-dir>] [--json]
 *
 * Fetches the scale reports of the last N completed nightly runs of
 * .github/workflows/scale-tier.yml (`gh run list` + `gh run download`, so a
 * read-only GITHUB_TOKEN / GH_TOKEN with actions:read is enough), or reads
 * <reports-dir>/<run-id>/**.json when --dir is given, and answers two
 * questions:
 *
 * 1. Are the interactive ceilings and calibrated budgets stable? Prints
 *    "ceilings stable" when N >= 5 nightly runs each have every engine/size
 *    under every ceiling and budget, with a coefficient of variation <= 15%
 *    per metric. Enforcement then flips with the repo variable
 *    GBRAIN_SCALE_ENFORCE_CEILINGS=1, a reviewed human step.
 * 2. Which sizes run tonight (the one cadence rule)? 10k + 20k nightly until
 *    the import-rate gate has passed at 20k on both engines on five
 *    consecutive nights (a missing 20k report counts as not passed), then
 *    50k nightly (sticky: once the latest night ran 50k it stays there).
 *
 * Exit 0 whatever the verdict (it is advice; the workflow reads --json);
 * exit 2 on a usage error.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ceilingsFor } from './gates.ts';

export const STABLE_RUNS = 5;
export const CV_MAX = 0.15;
export const DEFAULT_TIERS = [10_000, 20_000];
export const PROMOTED_TIERS = [50_000];
/** Promotion needs a 20k report from every engine: a cell that never wrote one (killed, cancelled) blocks it. */
export const ENGINES = ['pglite', 'postgres'];

export interface TrendReport {
  engine: string;
  pages: number;
  ops: Array<{ op: string; p50_ms: number }>;
  budgets_ms?: Record<string, number>;
  gates?: Array<{ gate: string; status: 'pass' | 'fail' }>;
}
/** One nightly run: its id and every scale report it uploaded. Newest run first. */
export interface TrendRun { id: string; reports: TrendReport[] }

const cv = (xs: number[]) => {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean === 0) return 0;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length) / mean;
};

export function assessCeilings(runs: TrendRun[]): { stable: boolean; lines: string[] } {
  const window = runs.slice(0, STABLE_RUNS);
  if (window.length < STABLE_RUNS) {
    return { stable: false, lines: [`only ${window.length} nightly run(s) with scale reports; ceilings need ${STABLE_RUNS} consecutive stable runs before enforcement.`] };
  }
  const groups = new Set(window.flatMap(r => r.reports.map(rep => `${rep.engine}:${rep.pages}`)));
  const lines: string[] = [];
  let stable = groups.size > 0;
  for (const group of [...groups].sort()) {
    const series = window.map(r => r.reports.find(rep => `${rep.engine}:${rep.pages}` === group));
    if (series.some(s => !s)) {
      stable = false;
      lines.push(`${group}: missing from ${series.filter(s => !s).length} of the last ${STABLE_RUNS} nightly runs; not stable.`);
      continue;
    }
    const reports = series as TrendReport[];
    const limits: Record<string, number> = { ...ceilingsFor(reports[0]!.pages) };
    for (const [op, budget] of Object.entries(reports[0]!.budgets_ms ?? {})) limits[op] = Math.min(limits[op] ?? Infinity, budget);
    for (const [op, limit] of Object.entries(limits)) {
      const values = reports.map(rep => rep.ops.find(o => o.op === op)?.p50_ms);
      if (values.some(v => v === undefined)) continue;
      const xs = values as number[];
      const over = xs.filter(v => v > limit).length;
      const variation = cv(xs);
      const ok = over === 0 && variation <= CV_MAX;
      if (!ok) stable = false;
      lines.push(`${group} ${op}: p50 ${xs.join('/')} ms vs limit ${limit} ms; ${over} over; CV ${Math.round(variation * 100)}% (max ${CV_MAX * 100}%) -> ${ok ? 'stable' : 'not stable'}`);
    }
  }
  lines.push(stable
    ? 'ceilings stable: a reviewer may set the repo variable GBRAIN_SCALE_ENFORCE_CEILINGS=1 (gh variable set GBRAIN_SCALE_ENFORCE_CEILINGS --body 1).'
    : 'ceilings not stable yet: keep them report-only.');
  return { stable, lines };
}

export function nightlyTiers(runs: TrendRun[]): { tiers: number[]; reason: string } {
  if (runs[0]?.reports.some(r => r.pages >= PROMOTED_TIERS[0]!)) return { tiers: PROMOTED_TIERS, reason: 'the latest nightly run already ran 50k (promotion is sticky)' };
  const window = runs.slice(0, STABLE_RUNS);
  const ratePassedAt20k = (run: TrendRun) => {
    const at20k = run.reports.filter(r => r.pages === 20_000);
    return ENGINES.every(engine => at20k.some(r => r.engine === engine))
      && at20k.every(r => r.gates?.find(g => g.gate === 'import_rate')?.status === 'pass');
  };
  if (window.length === STABLE_RUNS && window.every(ratePassedAt20k)) {
    return { tiers: PROMOTED_TIERS, reason: `the import-rate gate passed at 20k on the last ${STABLE_RUNS} nights` };
  }
  return { tiers: DEFAULT_TIERS, reason: `the import-rate gate has passed at 20k on ${window.filter(ratePassedAt20k).length} of the last ${STABLE_RUNS} nights (needs ${STABLE_RUNS})` };
}

function reportsUnder(dir: string): TrendReport[] {
  const found: TrendReport[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { found.push(...reportsUnder(path)); continue; }
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as TrendReport & { harness?: string };
      if (parsed.harness === 'gbrain-scale') found.push(parsed);
    } catch { /* not a scale report */ }
  }
  return found;
}

function gh(args: string[]): string {
  const r = Bun.spawnSync(['gh', ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`gh ${args.join(' ')} failed: ${r.stderr.toString().trim()}`);
  return r.stdout.toString();
}

function fetchRuns(count: number): TrendRun[] {
  const listed = JSON.parse(gh(['run', 'list', '--workflow', 'scale-tier.yml', '--event', 'schedule', '--status', 'completed',
    '--limit', String(count), '--json', 'databaseId'])) as Array<{ databaseId: number }>;
  const root = mkdtempSync(join(tmpdir(), 'gbrain-scale-trend-'));
  return listed.map(({ databaseId }) => {
    const dir = join(root, String(databaseId));
    try { gh(['run', 'download', String(databaseId), '--pattern', 'scale-report-*', '--dir', dir]); } catch { /* a run with no reports counts as empty */ }
    return { id: String(databaseId), reports: existsSync(dir) ? reportsUnder(dir) : [] };
  });
}

if (import.meta.main) {
  const flag = (name: string) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
  const count = Number(flag('--runs') ?? STABLE_RUNS);
  if (!Number.isInteger(count) || count < 1) {
    console.log('Usage: bun scripts/scale/trend.ts [--runs <N>=5] [--dir <reports-dir>] [--json]');
    process.exit(2);
  }
  const dir = flag('--dir');
  let runs: TrendRun[] = [];
  let fetchError: string | undefined;
  try {
    runs = dir
      ? readdirSync(dir).filter(n => statSync(join(dir, n)).isDirectory()).sort().reverse().slice(0, count).map(id => ({ id, reports: reportsUnder(join(dir, id)) }))
      : fetchRuns(count);
  } catch (e) {
    fetchError = `could not read nightly reports (${e instanceof Error ? e.message : String(e)}); treating history as empty. `
      + 'Check that gh is authenticated (GH_TOKEN with actions:read) and that scale-tier.yml has completed nightly runs.';
  }
  const ceilings = assessCeilings(runs);
  const cadence = nightlyTiers(runs);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ runs: runs.map(r => ({ id: r.id, reports: r.reports.length })), ceilings, tiers: cadence.tiers, cadence_reason: cadence.reason, ...(fetchError ? { warning: fetchError } : {}) }));
  } else {
    if (fetchError) console.log(`[trend] ${fetchError}`);
    console.log(`[trend] ${runs.length} nightly run(s): ${runs.map(r => `${r.id} (${r.reports.length} reports)`).join(', ') || 'none'}`);
    for (const line of ceilings.lines) console.log(`[trend] ${line}`);
    console.log(`[trend] tonight's sizes: ${cadence.tiers.join(', ')} (${cadence.reason})`);
  }
}
