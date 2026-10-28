/**
 * #5886: a supersession's pointer lives on the OLD fence row.
 *
 * Protects: after `takes_supersede` on a coordinated (managed) brain the old
 * `takes` row carries `superseded_by = <new row>`, keeps its own provenance in
 * the fence source cell, and the new row does not cite itself.
 * Fails when: `supersedeRow` writes `superseded by #N` onto the new row, so the
 * canonical projection (which reads the pointer from the inactive row) stores
 * `superseded_by = NULL`.
 * Seams: none; real PGLite + the persistence coordinator.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { parseTakesFence, renderTakesFence, supersedeRow } from '../src/core/takes-fence.ts';
import { takesPreparation } from '../src/core/takes-write.ts';

const BODY = `# Example\n\n## Takes\n\n${renderTakesFence([
  { rowNum: 1, claim: 'Widget co ships in Q3', kind: 'bet', holder: 'world', weight: 0.6, source: 'call notes', active: true },
  { rowNum: 2, claim: 'Acme example hires a CFO', kind: 'bet', holder: 'world', weight: 0.5, source: 'superseded by #2', active: true },
])}\n`;

test('supersedeRow puts the pointer on the old row after its provenance; the new row cites nothing', () => {
  const { body, newRowNum } = supersedeRow(BODY, 1, { claim: 'Widget co ships in Q4', kind: 'bet', holder: 'world', weight: 0.7 });
  const rows = parseTakesFence(body).takes;
  expect(rows.find(t => t.rowNum === 1)).toMatchObject({ active: false, source: `call notes; superseded by #${newRowNum}` });
  expect(rows.find(t => t.rowNum === newRowNum)!.source).toBeUndefined();
  expect(takesPreparation.toCanonicalBatchInput(7, rows.find(t => t.rowNum === 1)!).superseded_by).toBe(newRowNum);
});

test('a legacy self-reference on the superseded row is replaced, not chained', () => {
  const { body, newRowNum } = supersedeRow(BODY, 2, { claim: 'Acme example hires a COO', kind: 'bet', holder: 'world', weight: 0.5, source: 'board memo' });
  const rows = parseTakesFence(body).takes;
  expect(rows.find(t => t.rowNum === 2)!.source).toBe(`superseded by #${newRowNum}`);
  expect(rows.find(t => t.rowNum === newRowNum)!.source).toBe('board memo');
  expect(takesPreparation.toCanonicalBatchInput(7, rows.find(t => t.rowNum === 2)!).superseded_by).toBe(newRowNum);
});

let engine: PGLiteEngine;
let ctx: OperationContext;
const root = mkdtempSync(join(tmpdir(), 'gbrain-supersede-pointer-'));
const sourceId = 'supersede-pointer-test';
const submit = (operation: string, params: Record<string, unknown>) =>
  submitPageMutation(ctx, { operation, params: { request_id: randomUUID(), ...params } }) as Promise<Record<string, unknown>>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  ctx = { engine, config: { engine: 'pglite' }, sourceId, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
  await engine.connect({}); await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  await submit('put_page', { slug: 'page', content: `---\ntype: note\ntitle: Example\n---\n${BODY}` });
}, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(root, { recursive: true, force: true }); });

test('coordinated takes_supersede stores superseded_by on the old row and keeps it through a canonical re-projection', async () => {
  const result = await submit('takes_supersede', { slug: 'page', row_num: 1, claim: 'Widget co ships in Q4' });
  expect(result.state).toBe('committed');
  const pageId = (await engine.readPageSnapshot('page', { sourceId }))!.page.id;
  const rows = () => engine.executeRaw<{ row_num: number; source: string | null; active: boolean; superseded_by: number | null }>(
    'SELECT row_num, source, active, superseded_by FROM takes WHERE page_id=$1 ORDER BY row_num', [pageId]);
  const after = await rows();
  expect(after.find(r => r.row_num === 1)).toMatchObject({ active: false, superseded_by: 3, source: 'call notes; superseded by #3' });
  expect(after.find(r => r.row_num === 3)).toMatchObject({ active: true, superseded_by: null });
  expect(after.find(r => r.row_num === 3)!.source ?? '').not.toContain('superseded by');

  const fence = parseTakesFence(readFileSync(join(root, 'page.md'), 'utf8')).takes;
  await engine.addTakesBatch(fence.map(t => takesPreparation.toCanonicalBatchInput(pageId, t)));
  expect((await rows()).find(r => r.row_num === 1)!.superseded_by).toBe(3);
});
