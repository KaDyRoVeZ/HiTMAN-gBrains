/**
 * Temporal typed edges — read surfaces: get_links / get_backlinks /
 * traverse_graph status, as_of and during params, the hidden-relationships
 * notice + meta, entity cards (all edges with status, relationship note,
 * rendered context_pack line), the relational search arm and the
 * graph.edge_validity off switch.
 */
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { renderCardLine } from '../src/core/context/turn-context.ts';
import { buildRelationalArm } from '../src/core/search/relational-recall.ts';
import { appendRelationshipNotes, loadRelationshipNotes, relationshipNoteKey } from '../src/core/link-relationship-notes.ts';
import { compileView } from '../src/core/context/compile-view.ts';
import { loadSensitivityConfig } from '../src/core/context/sensitivity-scan.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

setDefaultTimeout(60_000);
let engine: PGLiteEngine;
const notices: Notice[] = [];
const meta: Record<string, unknown> = {};

const ctx = (remote = false): OperationContext => ({
  engine, config: { engine: 'pglite' as const }, logger: { info: () => {}, warn: () => {}, error: () => {} },
  dryRun: false, remote, sourceId: 'default',
  emitNotice: (n: Notice) => { notices.push(n); },
  emitResponseMeta: (k: string, v: unknown) => { meta[k] = v; },
} as OperationContext);
const op = (name: string) => operations.find(o => o.name === name)!;

async function put(slug: string, fm: string, body: string) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  await op('put_page').handler(ctx(), { slug, ...(snapshot ? { expected_revision: snapshot.revision } : {}), content: `---\n${fm}\n---\n\n${body}` });
}
const targets = (rows: unknown) => (rows as Array<{ to_slug: string }>).map(r => r.to_slug).sort();
const sources = (rows: unknown) => (rows as Array<{ from_slug: string }>).map(r => r.from_slug).sort();

beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); resetGateway();
  await put('companies/acme-example', 'type: company\ntitle: Acme', 'A company.');
  await put('companies/widget-co', 'type: company\ntitle: Widget', 'Another company.');
  await put('people/alice-example', 'type: person\ntitle: Alice', [
    'Alice is CTO of [Acme](../companies/acme-example).',
    '',
    '## Timeline',
    '',
    '- **2019-02-01** | linkedin — Joined [Acme](../companies/acme-example) as CTO',
    '- **2025-03-01** | linkedin — Left [Acme](../companies/acme-example) to join [Widget](../companies/widget-co)',
    '- **2025-03-02** | note — works at [Widget](../companies/widget-co)',
  ].join('\n'));
});
afterAll(async () => { await engine.disconnect(); resetGateway(); });

describe('get_links / get_backlinks', () => {
  test('default returns live relationships with status and dates; notice names the history call', async () => {
    notices.length = 0;
    const rows = await op('get_links').handler(ctx(), { slug: 'people/alice-example', link_type: 'works_at' }) as Array<Record<string, unknown>>;
    expect(targets(rows)).toEqual(['companies/widget-co']);
    expect(rows[0].status).toBeUndefined(); // default reads keep the established row shape
    const history = await op('get_links').handler(ctx(), { slug: 'people/alice-example', link_type: 'works_at', status: 'live', as_of: '2026-01-01' }) as Array<Record<string, unknown>>;
    expect(history[0].status).toBe('live');
    expect(history[0].stints).toEqual([{ from: '2025-03-01', until: null }]);
    const notice = notices.find(n => n.code === 'former_relationships_hidden')!;
    expect(notice.why).toContain('1 relationship');
    expect(notice.fix?.mcp).toEqual({ tool: 'get_links', arguments: { slug: 'people/alice-example', link_type: 'works_at', status: 'all' } });
    expect((meta['gbrain.temporal'] as { hidden: number }).hidden).toBe(1);
  });

  test('status all, ended, as_of and during', async () => {
    const all = await op('get_links').handler(ctx(), { slug: 'people/alice-example', link_type: 'works_at', status: 'all' }) as Array<Record<string, unknown>>;
    expect(targets(all)).toEqual(['companies/acme-example', 'companies/widget-co']);
    expect(all.find(r => r.to_slug === 'companies/acme-example')!.status).toBe('ended');
    expect(targets(await op('get_links').handler(ctx(), { slug: 'people/alice-example', link_type: 'works_at', status: 'ended' }))).toEqual(['companies/acme-example']);
    expect(targets(await op('get_links').handler(ctx(), { slug: 'people/alice-example', link_type: 'works_at', as_of: '2022-06-30' }))).toEqual(['companies/acme-example']);
    expect(targets(await op('get_links').handler(ctx(), { slug: 'people/alice-example', link_type: 'works_at', during: '2025' }))).toEqual(['companies/acme-example', 'companies/widget-co']);
    expect(sources(await op('get_backlinks').handler(ctx(), { slug: 'companies/acme-example', link_type: 'works_at' }))).toEqual([]);
    expect(sources(await op('get_backlinks').handler(ctx(), { slug: 'companies/acme-example', link_type: 'works_at', status: 'ended' }))).toEqual(['people/alice-example']);
  });

  test('invalid temporal params are rejected with guidance', async () => {
    await expect(op('get_links').handler(ctx(), { slug: 'people/alice-example', as_of: 'last year' })).rejects.toThrow(/as_of/);
    await expect(op('get_links').handler(ctx(), { slug: 'people/alice-example', status: 'former' })).rejects.toThrow(/status/);
  });

  test('graph.edge_validity off returns every edge as before', async () => {
    await engine.setConfig('graph.edge_validity', 'off');
    try {
      expect(targets(await op('get_links').handler(ctx(), { slug: 'people/alice-example', link_type: 'works_at' }))).toEqual(['companies/acme-example', 'companies/widget-co']);
    } finally { await engine.setConfig('graph.edge_validity', 'on'); }
  });
});

describe('traverse_graph', () => {
  test('walks live relationships by default, history with status all, the past with as_of', async () => {
    const walk = async (p: Record<string, unknown>) => ((await op('traverse_graph').handler(ctx(), { slug: 'people/alice-example', depth: 2, direction: 'out', link_type: 'works_at', ...p })) as Array<{ to_slug: string }>).map(e => e.to_slug).sort();
    expect(await walk({})).toEqual(['companies/widget-co']);
    expect(await walk({ status: 'all' })).toEqual(['companies/acme-example', 'companies/widget-co']);
    expect(await walk({ as_of: '2022-01-01' })).toEqual(['companies/acme-example']);
  });
});

describe('entity cards and context_pack text', () => {
  test('card keeps every edge with status, live first, and carries the relationship note', async () => {
    const res = await buildEntityCard(engine, 'default', 'people/alice-example', { remote: false });
    const card = (res as { card: Parameters<typeof renderCardLine>[0] }).card;
    const works = card.edges.filter(e => e.type === 'works_at');
    expect(works.map(e => `${e.slug}:${e.status}`)).toEqual(['companies/widget-co:live', 'companies/acme-example:ended']);
    expect(card.relationship_note).toContain('now: works_at widget-co (since 2025-03-01)');
    expect(card.relationship_note).toContain('ended: works_at acme-example (2025-03-01)');
    expect(card.relationship_note).toContain('summary may be stale');
    expect(renderCardLine(card)).toContain('[now: works_at widget-co');
  });
});

describe('relationship note on ambient and compiled context', () => {
  test('one batched loader; ambient synopses and compiled entries carry the note, world scope only', async () => {
    const notes = await loadRelationshipNotes(engine, [
      { slug: 'people/alice-example', source_id: 'default', summary: 'Alice is CTO of Acme.' },
      { slug: 'companies/widget-co', source_id: 'default', summary: 'Another company.' },
    ], { excludePrivate: true });
    expect(notes.get(relationshipNoteKey('default', 'people/alice-example'))).toContain('summary may be stale');
    expect(notes.has(relationshipNoteKey('default', 'companies/widget-co'))).toBe(false);

    const items = [{ slug: 'people/alice-example', source_id: 'default', synopsis: 'Alice is CTO of Acme.' }];
    await appendRelationshipNotes(engine, items);
    expect(items[0].synopsis).toMatch(/^Alice is CTO of Acme\. \[now: works_at widget-co .*ended: works_at acme-example \(2025-03-01\)/);

    const tmp = mkdtempSync(join(tmpdir(), 'temporal-compile-'));
    const scanConfig = loadSensitivityConfig({ workspaceRoot: tmp, blocklist: '', userPatternsPath: join(tmp, 'none.txt') });
    const { text } = await compileView({ engine, sourceId: 'default', target: 'claude-code', budget: 4000, scanConfig });
    expect(text).toContain('relationships: now: works_at widget-co');
  });
});

describe('relational search arm', () => {
  test('present tense asks for live relationships; "former" asks for ended ones', async () => {
    const now = await buildRelationalArm(engine, 'who works at acme-example', {});
    expect(now.map(r => r.slug)).not.toContain('people/alice-example');
    const former = await buildRelationalArm(engine, 'who were the former employees of acme-example', {});
    const worked = await buildRelationalArm(engine, 'who worked at acme-example', {});
    expect([...former, ...worked].map(r => r.slug)).toContain('people/alice-example');
  });
});

describe('add_link valid_from / valid_until', () => {
  test('dated manual edges close and reopen; invalid dates are rejected', async () => {
    await put('companies/fund-b', 'type: company\ntitle: Fund B', 'A fund.');
    await op('add_link').handler(ctx(), { from: 'people/alice-example', to: 'companies/fund-b', link_type: 'advises', valid_from: '2020-01-01' });
    const live = async () => targets(await op('get_links').handler(ctx(), { slug: 'people/alice-example', link_type: 'advises' }));
    expect(await live()).toEqual(['companies/fund-b']);
    await op('add_link').handler(ctx(), { from: 'people/alice-example', to: 'companies/fund-b', link_type: 'advises', valid_until: '2024-01-01' });
    expect(await live()).toEqual([]);
    expect(targets(await op('get_links').handler(ctx(), { slug: 'people/alice-example', link_type: 'advises', as_of: '2022-01-01' }))).toEqual(['companies/fund-b']);
    await expect(op('add_link').handler(ctx(), { from: 'people/alice-example', to: 'companies/fund-b', link_type: 'advises', valid_until: '2024-13-01' })).rejects.toThrow(/valid_until/);
    await expect(op('add_link').handler(ctx(), { from: 'people/alice-example', to: 'companies/fund-b', link_type: 'mentions', valid_from: '2024-01-01' })).rejects.toThrow(/no dates/);
    await expect(op('add_link').handler(ctx(), { from: 'people/alice-example', to: 'companies/fund-b', link_type: 'invested_in', valid_until: '2024-01-01' })).rejects.toThrow(/does not end/);
    await op('remove_link').handler(ctx(), { from: 'people/alice-example', to: 'companies/fund-b', link_type: 'advises' });
    const left = await engine.executeRaw(`SELECT 1 FROM link_transitions WHERE producer = 'manual'`);
    expect(left.length).toBe(0);
  });
});
