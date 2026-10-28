/**
 * End-to-end smoke of the scale harness (scripts/scale/run.ts) at a tiny size:
 * the workflow trusts its exit code, so a harness that crashes (exit 3) or
 * mis-wires an op (a known answer fails) must show up here before a nightly
 * run finds it. PGLite only; the Postgres cell runs in scale-tier.yml.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const RUN = resolve(import.meta.dir, '../../scripts/scale/run.ts');

async function harness(args: string[]): Promise<{ code: number; stdout: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'DATABASE_URL' && k !== 'GBRAIN_DATABASE_URL') env[k] = v;
  const child = Bun.spawn([process.execPath, RUN, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, stdout };
}

test('a 40-page enforced PGLite run passes every enforced gate and writes a headline-first report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'scale-harness-'));
  try {
    const out = join(dir, 'report.json');
    const { code, stdout } = await harness(['--pages', '40', '--seed', '5', '--corpus-dir', join(dir, 'corpus'), '--out', out, '--enforce']);
    expect({ code, tail: stdout.split('\n').filter(l => l.includes('GATE FAIL') || l.includes('CRASH')) }).toEqual({ code: 0, tail: [] });
    const report = JSON.parse(readFileSync(out, 'utf8'));
    expect(Object.keys(report)[0]).toBe('headline');
    expect(report.headline.metric).toBe('MCP search p50 at 40 brain pages, as shipped (no manual ANALYZE)');
    expect(report.ops.filter((o: { known_answer: string }) => o.known_answer !== 'pass')).toEqual([]);
    expect(report.data.every((d: { status: string }) => d.status === 'pass')).toBe(true);
    // Planner health is probed after the first timed op (F4b analyzes on the first planner-sensitive read), with each table's row count.
    expect(report.planner.probed_after).toBe(report.ops[0].op);
    expect(Object.keys(report.planner.hot_table_rows).sort()).toEqual(Object.keys(report.planner.hot_table_stat_rows).sort());
    expect(report.planner.hot_table_rows.pages).toBeGreaterThan(0);
    expect(report.policy.planner_health).toBe('enforced');
    // F4d operational ceilings run through the real CLI at every tier; the 20k-file add only from 20k pages.
    expect(report.data.map((d: { check: string }) => d.check)).toEqual(expect.arrayContaining(['f4d_sync_deadline', 'f4d_embed_budget_stop', 'f4d_serve_boot']));
    expect(report.f4d.embed_budget_stop.exit_code).toBe(11);
    expect(report.f4d.sources_add_20k).toEqual({ skipped: 'runs at 20000 pages and up' });
    expect(report.ops.map((o: { op: string }) => o.op)).toEqual(expect.arrayContaining([
      'query (hybrid, injected vector)', 'search (MCP path, source-scoped grant)', 'cold-process first query (MCP path)', 'concurrent put_page x2 (receipts)']));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);

test('--engine postgres without DATABASE_URL exits 2 and says what to set', async () => {
  const { code, stdout } = await harness(['--engine', 'postgres', '--pages', '40']);
  expect(code).toBe(2);
  expect(stdout).toContain('--engine postgres needs DATABASE_URL');
});
