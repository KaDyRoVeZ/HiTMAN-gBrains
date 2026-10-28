/**
 * Temporal typed edges — pack-declared relation semantics
 * (`link_types[].temporal`): manifest validation, lint, the merge rule, and a
 * pack relation (`reports_to`) that gains validity dates through add_link and
 * the explicit timeline grammar.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { parseSchemaPackManifest } from '../src/core/schema-pack/manifest-v1.ts';
import { linkTypesTemporal } from '../src/core/schema-pack/lint-rules.ts';
import { __setPackLocatorForTests, _resetPackLocatorForTests, _resetPackCacheForTests } from '../src/core/schema-pack/index.ts';
import { bundledPackPath } from '../src/core/schema-pack/bundled-assets.ts';
import { packRelationSemantics, primeRelationSemantics } from '../src/core/link-semantics-pack.ts';
import { relationSemantics, setPackRelationSemantics, temporalLinkTypes } from '../src/core/link-validity.ts';

setDefaultTimeout(60_000);

const base = { api_version: 'gbrain-schema-pack-v1', name: 'org-fixture', version: '1.0.0', extends: null, page_types: [], frontmatter_links: [] };
const orgPack = { ...base, link_types: [{ name: 'reports_to', inverse: 'manages', temporal: 'state' }, { name: 'manages', inverse: 'reports_to', temporal: 'state' }, { name: 'promoted', temporal: 'event' }] };

describe('manifest and lint', () => {
  test('temporal accepts state and event, rejects anything else', () => {
    expect(parseSchemaPackManifest(orgPack).link_types.map(l => l.temporal)).toEqual(['state', 'state', 'event']);
    expect(() => parseSchemaPackManifest({ ...base, link_types: [{ name: 'reports_to', temporal: 'forever' }] })).toThrow();
  });

  test("lint: mentions is an error; a built-in override and an inverse mismatch warn", async () => {
    const issues = await linkTypesTemporal(parseSchemaPackManifest({ ...base, link_types: [
      { name: 'mentions', temporal: 'state' },
      { name: 'works_at', temporal: 'event' },
      { name: 'reports_to', inverse: 'manages', temporal: 'state' },
      { name: 'manages', inverse: 'reports_to', temporal: 'event' },
    ] }), {});
    expect(issues.map(i => [i.rule, i.severity, i.link])).toEqual([
      ['link_types_temporal_mentions', 'error', 'mentions'],
      ['link_types_temporal_overrides_builtin', 'warning', 'works_at'],
      ['link_types_temporal_inverse_mismatch', 'warning', 'reports_to'],
      ['link_types_temporal_inverse_mismatch', 'warning', 'manages'],
    ]);
    expect(await linkTypesTemporal(parseSchemaPackManifest(orgPack), {})).toEqual([]);
  });

  test('merge: state wins a disagreement between packs; mentions is ignored', () => {
    const merged = packRelationSemantics([
      { link_types: [{ name: 'owned_by', temporal: 'event' }, { name: 'mentions', temporal: 'state' }] },
      { link_types: [{ name: 'owned_by', temporal: 'state' }] },
      null,
    ] as never);
    expect([...merged]).toEqual([['owned_by', 'state']]);
  });
});

describe('a pack relation through the write and read paths', () => {
  let engine: PGLiteEngine;
  let root: string;
  const ctx = (): OperationContext => ({ engine, config: { engine: 'pglite' as const }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'default' } as OperationContext);
  const op = (name: string) => operations.find(o => o.name === name)!;
  const put = async (slug: string, content: string) => {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
    await op('put_page').handler(ctx(), { slug, content, ...(snapshot ? { expected_revision: snapshot.revision } : {}) });
  };
  const reports = async (params: Record<string, unknown> = {}) =>
    (await op('get_links').handler(ctx(), { slug: 'people/alice-example', link_type: 'reports_to', ...params }) as Array<Record<string, unknown>>);

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-semantics-pack-'));
    writeFileSync(join(root, 'pack.json'), JSON.stringify(orgPack));
    __setPackLocatorForTests(name => name === orgPack.name ? join(root, 'pack.json') : bundledPackPath(name));
    _resetPackCacheForTests();
    engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    await engine.setConfig('schema_pack', orgPack.name);
    for (const slug of ['people/alice-example', 'people/bob-example', 'people/carol-example']) await put(slug, `---\ntype: person\ntitle: ${slug}\n---\n\nA person.\n`);
  });
  afterAll(async () => {
    await engine.disconnect();
    setPackRelationSemantics(new Map());
    _resetPackLocatorForTests(); _resetPackCacheForTests();
    rmSync(root, { recursive: true, force: true });
  });

  test('priming installs the pack semantics over the built-in table (page writes already primed)', async () => {
    expect(relationSemantics('reports_to')).toBe('state');
    setPackRelationSemantics(new Map());
    expect(relationSemantics('reports_to')).toBe('reference');
    await primeRelationSemantics(engine);
    expect(relationSemantics('reports_to')).toBe('state');
    expect(relationSemantics('promoted')).toBe('event');
    expect(relationSemantics('works_at')).toBe('state');
    expect(temporalLinkTypes()).toContain('reports_to');
  });

  test('add_link valid_until ends a pack state relation; default reads hide it, history keeps it', async () => {
    await op('add_link').handler(ctx(), { from: 'people/alice-example', to: 'people/bob-example', link_type: 'reports_to', valid_from: '2020-01-01', valid_until: '2023-06-01' });
    await op('add_link').handler(ctx(), { from: 'people/alice-example', to: 'people/carol-example', link_type: 'reports_to', valid_from: '2023-06-01' });
    expect((await reports()).map(r => r.to_slug)).toEqual(['people/carol-example']);
    const history = await reports({ status: 'all' });
    expect(history.map(r => [r.to_slug, r.status]).sort()).toEqual([['people/bob-example', 'ended'], ['people/carol-example', 'live']]);
    expect((await reports({ as_of: '2021-01-01' })).map(r => r.to_slug)).toEqual(['people/bob-example']);
  });

  test('the explicit timeline grammar ends a pack relation on the page that states it', async () => {
    await put('people/alice-example', [
      '---', 'type: person', 'title: Alice', '---', '', 'Alice is on the platform team.', '', '## Timeline', '',
      '- **2026-01-15** | note — Ended reports_to [[people/carol-example]]',
    ].join('\n'));
    expect(await reports()).toEqual([]);
    const carol = (await reports({ status: 'all' })).find(r => r.to_slug === 'people/carol-example')!;
    expect(carol.status).toBe('ended');
    expect(carol.stints).toEqual([{ from: '2023-06-01', until: '2026-01-15' }]);
  });
});
