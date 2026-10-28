/**
 * scripts/scale/trend.ts decides two things the scale-tier workflow acts on:
 * whether the report-only ceilings may be enforced ("ceilings stable") and
 * which brain sizes the nightly run uses (10k + 20k until the import-rate gate
 * passes at 20k five nights in a row, then 50k). Both read only the reports.
 */
import { expect, test } from 'bun:test';
import { assessCeilings, nightlyTiers, type TrendReport, type TrendRun } from '../../scripts/scale/trend.ts';

const report = (engine: string, pages: number, search: number, health: number, rate: 'pass' | 'fail' = 'pass'): TrendReport => ({
  engine, pages,
  ops: [{ op: 'search (MCP path, remote)', p50_ms: search }, { op: 'get_health', p50_ms: health }],
  gates: [{ gate: 'import_rate', status: rate }],
});
const runs = (n: number, make: (i: number) => TrendReport[]): TrendRun[] => Array.from({ length: n }, (_, i) => ({ id: String(100 - i), reports: make(i) }));

test('five steady nights under every ceiling read "ceilings stable"', () => {
  const verdict = assessCeilings(runs(5, i => [report('pglite', 10_000, 200 + i, 400), report('postgres', 10_000, 100, 300 + i)]));
  expect(verdict.stable).toBe(true);
  expect(verdict.lines.at(-1)).toContain('ceilings stable');
  expect(verdict.lines.at(-1)).toContain('GBRAIN_SCALE_ENFORCE_CEILINGS=1');
});

test('fewer than five nights, one night over a ceiling, or a noisy metric is not stable', () => {
  expect(assessCeilings(runs(4, () => [report('pglite', 10_000, 200, 400)])).stable).toBe(false);
  const over = assessCeilings(runs(5, i => [report('pglite', 10_000, i === 2 ? 501 : 200, 400)]));
  expect(over.stable).toBe(false);
  expect(over.lines.find(l => l.includes('search (MCP path, remote)'))).toContain('1 over');
  const noisy = assessCeilings(runs(5, i => [report('pglite', 10_000, [100, 400, 100, 400, 100][i]!, 400)]));
  expect(noisy.stable).toBe(false);
  expect(noisy.lines.find(l => l.includes('search (MCP path, remote)'))).toContain('not stable');
});

test('calibrated budgets in the reports are judged with the ceilings', () => {
  const withBudget = () => [{ ...report('pglite', 10_000, 200, 400), budgets_ms: { 'search (MCP path, remote)': 150 } }];
  expect(assessCeilings(runs(5, withBudget)).stable).toBe(false);
});

test('nightly sizes: 10k + 20k until the 20k rate gate passes five nights in a row, then 50k, sticky', () => {
  expect(nightlyTiers([]).tiers).toEqual([10_000, 20_000]);
  const passing = runs(5, () => [report('pglite', 20_000, 1, 1), report('postgres', 20_000, 1, 1)]);
  expect(nightlyTiers(passing).tiers).toEqual([50_000]);
  const oneFailed = runs(5, i => [report('pglite', 20_000, 1, 1, i === 3 ? 'fail' : 'pass'), report('postgres', 20_000, 1, 1)]);
  expect(nightlyTiers(oneFailed)).toMatchObject({ tiers: [10_000, 20_000], reason: expect.stringContaining('4 of the last 5') });
  expect(nightlyTiers(runs(1, () => [report('pglite', 50_000, 1, 1)])).tiers).toEqual([50_000]);
});

test('a 20k cell with no report (killed or cancelled) blocks promotion to 50k', () => {
  const pgliteMissing = runs(5, () => [report('postgres', 20_000, 1, 1)]);
  expect(nightlyTiers(pgliteMissing)).toMatchObject({ tiers: [10_000, 20_000], reason: expect.stringContaining('0 of the last 5') });
});
