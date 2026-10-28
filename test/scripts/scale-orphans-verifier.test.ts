/**
 * The scale tier's find_orphans known answer (scripts/scale/gates.ts
 * FIND_ORPHANS_PARAMS + orphansProblem) on a brain holding more orphans than
 * one default find_orphans page.
 *
 * Protects: the 20k scale gate's verdict on find_orphans. Since #5891 the op
 * returns one page of rows (default 100) plus `total_orphans`; a 20k fixture
 * holds 104 orphans in its default source, so a verifier that reads one
 * default page reports "an island page is missing" against a correct engine.
 * Fails when: the known-answer call drops back to the default page size, or
 * the check stops comparing the returned rows with `total_orphans`.
 * Why new: test/scripts/scale-gates.test.ts plants verdicts into finished
 * reports and never runs the op; the 40-page harness run holds one island.
 * Seam: none (the real op handler on an in-memory PGLite brain).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { FIND_ORPHANS_PARAMS, orphansProblem } from '../../scripts/scale/gates.ts';

const ISLANDS = 150;
let engine: PGLiteEngine;
const islands = Array.from({ length: ISLANDS }, (_, i) => `notes/island-${String(i).padStart(3, '0')}`);
const ctx = () => ({
  engine, config: {}, logger: { info() {}, warn() {}, error() {}, debug() {} }, dryRun: false, remote: false, sourceId: 'default',
}) as unknown as OperationContext;
const findOrphans = (params: Record<string, unknown>) => operations.find(o => o.name === 'find_orphans')!.handler(ctx(), params);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const slug of islands) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `Island ${slug}.`, frontmatter: {} });
  }
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

describe('scale find_orphans known answer with more orphans than one default page', () => {
  test('the verifier call returns every island and passes', async () => {
    const result = await findOrphans({ ...FIND_ORPHANS_PARAMS });
    expect((result as { total_orphans: number }).total_orphans).toBe(ISLANDS);
    expect(orphansProblem(result, islands)).toBeNull();
  });

  test('one default page is reported as truncated, never as a missing island', async () => {
    const page = await findOrphans({});
    expect((page as { orphans: unknown[] }).orphans).toHaveLength(100);
    expect(orphansProblem(page, islands)).toContain(`returned 100 of ${ISLANDS} orphans in one call`);
  });

  test('a real omission is still named', async () => {
    const result = await findOrphans({ ...FIND_ORPHANS_PARAMS }) as { orphans: Array<{ slug: string }>; total_orphans: number };
    const missingOne = { ...result, orphans: result.orphans.slice(1), total_orphans: result.total_orphans - 1 };
    expect(orphansProblem(missingOne, islands)).toContain(`fewer than the fixture's ${ISLANDS} island pages`);
    const wrongRow = { ...result, orphans: [{ slug: 'notes/not-an-island' }, ...result.orphans.slice(1)] };
    expect(orphansProblem(wrongRow, islands)).toBe(`1 of ${ISLANDS} island pages missing from find_orphans (first: ${islands[0]})`);
  });
});
