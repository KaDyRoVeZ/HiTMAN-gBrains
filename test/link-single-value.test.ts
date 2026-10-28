/**
 * Declared single-value relations: a schema pack marks a state relation
 * `cardinality: one_per_from`, and the edge_contradictions phase closes a
 * page's competing live relationships of that type by the chain rule, with no
 * model. Covers the pure planner (out-of-order imports, undated, same-date),
 * the manifest and lint contract, and the phase on PGLite (apply, idempotent
 * rerun, hand-deleted closure, mode off, undated conflict).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { runPhaseEdgeContradictions } from '../src/core/cycle/edge-contradictions.ts';
import { planSingleValueClosures, declaredSingleValueTypes, previewSingleValue } from '../src/core/link-single-value.ts';
import { relationshipFilterSql } from '../src/core/link-validity.ts';
import { __setPackLocatorForTests, _resetPackLocatorForTests, _resetPackCacheForTests } from '../src/core/schema-pack/index.ts';
import { bundledPackPath } from '../src/core/schema-pack/bundled-assets.ts';
import { parseSchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { linkTypesCardinality } from '../src/core/schema-pack/lint-rules.ts';

setDefaultTimeout(60_000);

const stint = (from: string | null, until: string | null = null) => [{ from, until }];

describe('planSingleValueClosures', () => {
  test('an out-of-order import closes each relationship at the next dated start', () => {
    const plan = planSingleValueClosures([
      { to_page_id: 1, lastStart: '2024-01-10', stints: stint('2024-01-10'), recordedAt: null },
      { to_page_id: 2, lastStart: '2024-03-01', stints: stint('2024-03-01'), recordedAt: null },
      { to_page_id: 3, lastStart: '2024-02-01', stints: stint('2024-02-01'), recordedAt: null },
    ]);
    expect(plan.closures.map(c => [c.ending, c.successor, c.closeDate])).toEqual([[1, 3, '2024-02-01'], [3, 2, '2024-03-01']]);
    expect(plan.undated).toEqual([]);
  });

  test('undated and same-date members stay open as conflicts; an already-ended stint is left alone', () => {
    const plan = planSingleValueClosures([
      { to_page_id: 1, lastStart: null, stints: stint(null), recordedAt: null },
      { to_page_id: 2, lastStart: '2024-03-01', stints: stint('2024-03-01'), recordedAt: null },
      { to_page_id: 3, lastStart: '2024-03-01', stints: stint('2024-03-01'), recordedAt: null },
      { to_page_id: 4, lastStart: '2023-01-01', stints: stint('2023-01-01', '2023-06-01'), recordedAt: null },
    ]);
    expect(plan.undated).toEqual([1]);
    expect(plan.sameDate).toEqual([[2, 3]]);
    expect(plan.closures).toEqual([]);
  });
});

describe('cardinality in the pack contract', () => {
  const base = { api_version: 'gbrain-schema-pack-v1', name: 'sv-lint', version: '1.0.0', extends: null, page_types: [], frontmatter_links: [] };
  test('one_per_from parses; one_per_to and unknown values are rejected', () => {
    expect(parseSchemaPackManifest({ ...base, link_types: [{ name: 'works_at', cardinality: 'one_per_from' }] }).link_types[0]!.cardinality).toBe('one_per_from');
    expect(() => parseSchemaPackManifest({ ...base, link_types: [{ name: 'works_at', cardinality: 'one_per_to' }] })).toThrow();
  });
  test('lint rejects a single-value declaration on a relation without stints', async () => {
    const m = parseSchemaPackManifest({ ...base, link_types: [{ name: 'works_at', cardinality: 'one_per_from' }, { name: 'mentions', cardinality: 'one_per_from' }] });
    const issues = await linkTypesCardinality(m);
    expect(issues.map(i => [i.rule, i.link])).toEqual([['link_types_cardinality_not_state', 'mentions']]);
    const custom = parseSchemaPackManifest({ ...base, link_types: [{ name: 'reports_to', temporal: 'state', cardinality: 'one_per_from' }, { name: 'manages', cardinality: 'one_per_from' }] });
    expect((await linkTypesCardinality(custom)).map(i => i.link)).toEqual(['manages']);
  });
});

describe('declared single-value closures in edge_contradictions', () => {
  let engine: PGLiteEngine;
  let root: string;
  const pack = {
    api_version: 'gbrain-schema-pack-v1', name: 'single-value-fixture', version: '1.0.0', extends: 'gbrain-base',
    page_types: [], frontmatter_links: [], link_types: [{ name: 'works_at', cardinality: 'one_per_from' }],
  };
  const ctx = (): OperationContext => ({ engine, config: { engine: 'pglite' as const }, logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false, remote: false, sourceId: 'default' });
  async function put(slug: string, fm: string, body: string) {
    const op = operations.find(o => o.name === 'put_page')!;
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
    await op.handler(ctx(), { slug, ...(snapshot ? { expected_revision: snapshot.revision } : {}), content: `---\n${fm}\n---\n\n${body}` });
  }
  const COMPANIES = ['acme-example', 'widget-co', 'gadget-co'];
  async function seed(timeline: string) {
    for (const c of COMPANIES) await put(`companies/${c}`, `type: company\ntitle: ${c}`, 'A company.');
    await put('people/alice-example', 'type: person\ntitle: Alice',
      `Alice works at ${COMPANIES.map(c => `[${c}](../companies/${c})`).join(', ')}.\n\n## Timeline\n\n${timeline}`);
  }
  const OUT_OF_ORDER = [
    '- **2024-01-10** | test — joined [acme-example](../companies/acme-example)',
    '- **2024-03-01** | test — joined [widget-co](../companies/widget-co)',
    '- **2024-02-01** | test — joined [gadget-co](../companies/gadget-co)',
  ].join('\n');
  async function liveWorksAt() {
    const rows = await engine.executeRaw<{ slug: string }>(
      `SELECT DISTINCT t.slug FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
        WHERE f.slug = 'people/alice-example' AND l.link_type = 'works_at' AND ${relationshipFilterSql('l')} ORDER BY 1`);
    return rows.map(r => r.slug);
  }
  const proposals = () => engine.executeRaw<{ status: string; close_date: string | null; model: string }>(
    `SELECT status, close_date::text AS close_date, model FROM link_edge_proposals ORDER BY close_date NULLS LAST, id`);
  const noJudge = async () => { throw new Error('the judge must not be called for declared relations'); };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-single-value-'));
    writeFileSync(join(root, 'pack.json'), JSON.stringify(pack));
    __setPackLocatorForTests(name => (name === pack.name ? join(root, 'pack.json') : bundledPackPath(name)));
    _resetPackCacheForTests();
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => {
    await engine.disconnect();
    _resetPackLocatorForTests();
    _resetPackCacheForTests();
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await resetPgliteState(engine);
    await engine.setConfig('schema_pack', pack.name);
  });

  test('the source pack declaration is read; the bundled default declares nothing', async () => {
    expect([...await declaredSingleValueTypes(engine, 'default')]).toEqual(['works_at']);
    await engine.setConfig('schema_pack', 'gbrain-base');
    expect([...await declaredSingleValueTypes(engine, 'default')]).toEqual([]);
  });

  test('the preview lists what the dream cycle would close, without writing', async () => {
    await seed(OUT_OF_ORDER);
    const preview = await previewSingleValue(engine);
    expect(preview.declared).toEqual({ default: ['works_at'] });
    expect(preview.groups).toHaveLength(1);
    expect(preview.groups[0]!.would_close).toEqual([
      { target: 'companies/acme-example', close_date: '2024-02-01', superseded_by: 'companies/gadget-co' },
      { target: 'companies/gadget-co', close_date: '2024-03-01', superseded_by: 'companies/widget-co' },
    ]);
    expect(await liveWorksAt()).toEqual(['companies/acme-example', 'companies/gadget-co', 'companies/widget-co']);
  });

  test('by default closures are proposals: nothing is written and the relationships stay live', async () => {
    await engine.executeRaw(`DELETE FROM config WHERE key = 'dream.single_value.mode'`);
    await seed(OUT_OF_ORDER);
    const r = await runPhaseEdgeContradictions(engine, { judge: noJudge });
    expect(r.totals).toMatchObject({ declared_proposed: 2, declared_applied: 0 });
    expect((await proposals()).map(p => p.status)).toEqual(['proposed', 'proposed']);
    expect(await liveWorksAt()).toEqual(['companies/acme-example', 'companies/gadget-co', 'companies/widget-co']);
  });

  test('closes the chain with no model, lands as timeline lines, and a rerun changes nothing', async () => {
    await engine.setConfig('dream.single_value.mode', 'apply');
    await seed(OUT_OF_ORDER);
    expect(await liveWorksAt()).toEqual(['companies/acme-example', 'companies/gadget-co', 'companies/widget-co']);
    const r = await runPhaseEdgeContradictions(engine, { judge: noJudge });
    expect(r.totals).toMatchObject({ declared_proposed: 2, declared_applied: 2 });
    expect(await liveWorksAt()).toEqual(['companies/widget-co']);
    expect((await proposals()).map(p => [p.status, p.close_date, p.model])).toEqual([
      ['applied', '2024-02-01', 'schema-pack:cardinality'], ['applied', '2024-03-01', 'schema-pack:cardinality'],
    ]);
    const page = await engine.getPage('people/alice-example', { sourceId: 'default' });
    expect(page?.timeline).toContain('Ended works_at [[companies/acme-example]] (superseded by works_at companies/gadget-co)');
    expect(page?.timeline).toContain('Ended works_at [[companies/gadget-co]] (superseded by works_at companies/widget-co)');
    const again = await runPhaseEdgeContradictions(engine, { judge: noJudge });
    expect(again.totals).toMatchObject({ subjects: 0 });
  });

  test('a hand-deleted closure line is reverted and never re-applied', async () => {
    await engine.setConfig('dream.single_value.mode', 'apply');
    await seed(OUT_OF_ORDER);
    await runPhaseEdgeContradictions(engine, { judge: noJudge });
    await seed(OUT_OF_ORDER);
    expect(await liveWorksAt()).toEqual(['companies/acme-example', 'companies/gadget-co', 'companies/widget-co']);
    const r = await runPhaseEdgeContradictions(engine, { judge: noJudge });
    expect(r.totals).toMatchObject({ reverted: 2, declared_proposed: 0 });
    expect(await liveWorksAt()).toEqual(['companies/acme-example', 'companies/gadget-co', 'companies/widget-co']);
  });

  test('undated members stay open; dream.single_value.mode off hands the group back to the judge path', async () => {
    await seed('- **2024-03-01** | test — joined [widget-co](../companies/widget-co)');
    const r = await runPhaseEdgeContradictions(engine, { judge: noJudge });
    expect(r.totals).toMatchObject({ declared_undated_unresolved: 2, declared_proposed: 0 });
    expect(await liveWorksAt()).toEqual(['companies/acme-example', 'companies/gadget-co', 'companies/widget-co']);

    await resetPgliteState(engine);
    await engine.setConfig('schema_pack', pack.name);
    await engine.setConfig('dream.single_value.mode', 'off');
    await engine.setConfig('dream.edge_contradictions.mode', 'off');
    await seed(OUT_OF_ORDER);
    expect((await runPhaseEdgeContradictions(engine, { judge: noJudge })).status).toBe('skipped');
    expect(await liveWorksAt()).toEqual(['companies/acme-example', 'companies/gadget-co', 'companies/widget-co']);
  });
});
