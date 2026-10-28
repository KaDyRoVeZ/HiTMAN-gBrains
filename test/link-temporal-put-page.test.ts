/**
 * Temporal typed edges through put_page: the write path derives tense and
 * dated transitions from the page and refreshes relationship state in the
 * same transaction as derived-link replacement (zero LLM).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { resetGateway } from '../src/core/ai/gateway.ts';
import { relationshipFilterSql, parseMultirange } from '../src/core/link-validity.ts';

setDefaultTimeout(30_000);
let engine: PGLiteEngine;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); resetGateway(); });
beforeEach(async () => { await resetPgliteState(engine); resetGateway(); });

const ctx = (): OperationContext => ({
  engine, config: { engine: 'pglite' as const }, logger: { info: () => {}, warn: () => {}, error: () => {} },
  dryRun: false, remote: false, sourceId: 'default',
});
const putPage = operations.find(o => o.name === 'put_page')!;

async function put(slug: string, frontmatter: string, body: string) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  return putPage.handler(ctx(), { slug, ...(snapshot ? { expected_revision: snapshot.revision } : {}), content: `---\n${frontmatter}\n---\n\n${body}` });
}

async function liveWorksAt(slug: string, opts: Parameters<typeof relationshipFilterSql>[1] = {}) {
  const rows = await engine.executeRaw<{ slug: string }>(
    `SELECT DISTINCT t.slug FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = $1 AND l.link_type = 'works_at' AND ${relationshipFilterSql('l', opts)} ORDER BY t.slug`, [slug]);
  return rows.map(r => r.slug);
}

describe('put_page derives temporal evidence', () => {
  test('timeline cues close the old employer and open the new one', async () => {
    await put('companies/acme-example', 'type: company\ntitle: Acme', 'A company.');
    await put('companies/widget-co', 'type: company\ntitle: Widget', 'Another company.');
    await put('people/alice-example', 'type: person\ntitle: Alice', [
      'Alice is CTO of [Acme](../companies/acme-example). She works at [Widget](../companies/widget-co).',
      '',
      '## Timeline',
      '',
      '- **2019-02-01** | linkedin — Joined [Acme](../companies/acme-example) as CTO',
      '- **2025-03-01** | linkedin — Left [Acme](../companies/acme-example) to join [Widget](../companies/widget-co)',
    ].join('\n'));

    const links = await engine.executeRaw<{ slug: string; link_type: string }>(
      `SELECT t.slug, l.link_type FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id WHERE f.slug = 'people/alice-example' ORDER BY 1, 2`);
    expect(links.filter(l => l.link_type === 'works_at').map(l => l.slug)).toEqual(['companies/acme-example', 'companies/widget-co']);

    const transitions = await engine.executeRaw<{ slug: string; kind: string; occurred_on: string; producer: string }>(
      `SELECT t.slug, lt.kind, lt.occurred_on::text AS occurred_on, lt.producer FROM link_transitions lt JOIN pages t ON t.id = lt.to_page_id ORDER BY lt.occurred_on, t.slug`);
    expect(transitions).toEqual([
      { slug: 'companies/acme-example', kind: 'start', occurred_on: '2019-02-01', producer: 'timeline' },
      { slug: 'companies/acme-example', kind: 'end', occurred_on: '2025-03-01', producer: 'timeline' },
      { slug: 'companies/widget-co', kind: 'start', occurred_on: '2025-03-01', producer: 'timeline' },
    ]);

    expect(await liveWorksAt('people/alice-example')).toEqual(['companies/widget-co']);
    expect(await liveWorksAt('people/alice-example', { asOf: '2022-01-01' })).toEqual(['companies/acme-example']);
    const [state] = await engine.executeRaw<{ valid_ranges: string; status_now: string }>(
      `SELECT lr.valid_ranges::text AS valid_ranges, lr.status_now FROM link_relationships lr JOIN pages t ON t.id = lr.to_page_id
        WHERE t.slug = 'companies/acme-example' AND lr.scope = 'all'`);
    expect(parseMultirange(state.valid_ranges)).toEqual([{ from: '2019-02-01', until: '2025-03-01' }]);
    expect(state.status_now).toBe('ended');
  });

  test('past-tense prose marks the assertion past and the relationship ended (date unknown)', async () => {
    await put('companies/acme-example', 'type: company\ntitle: Acme', 'A company.');
    await put('people/bob-example', 'type: person\ntitle: Bob', 'Bob previously worked at [Acme](../companies/acme-example) before going independent.');
    const [row] = await engine.executeRaw<{ assertion_tense: string | null; link_type: string }>(
      `SELECT l.assertion_tense, l.link_type FROM links l JOIN pages f ON f.id = l.from_page_id WHERE f.slug = 'people/bob-example'`);
    expect(row).toEqual({ assertion_tense: 'past', link_type: 'works_at' });
    expect(await liveWorksAt('people/bob-example')).toEqual([]);
    expect(await liveWorksAt('people/bob-example', { status: 'ended' })).toEqual(['companies/acme-example']);
  });

  test('an explicit closure line survives deleting the stale sentence, and editing it away reopens', async () => {
    await put('companies/acme-example', 'type: company\ntitle: Acme', 'A company.');
    await put('people/carol-example', 'type: person\ntitle: Carol', 'Carol is an engineer at [Acme](../companies/acme-example).\n\n- **2024-06-01** | me — Ended works_at [[companies/acme-example]]');
    expect(await liveWorksAt('people/carol-example')).toEqual([]);
    expect(await liveWorksAt('people/carol-example', { asOf: '2024-01-01' })).toEqual(['companies/acme-example']);

    await put('people/carol-example', 'type: person\ntitle: Carol', 'Carol is an engineer at [Acme](../companies/acme-example).');
    expect(await liveWorksAt('people/carol-example')).toEqual(['companies/acme-example']);
    const transitions = await engine.executeRaw(`SELECT 1 FROM link_transitions`);
    expect(transitions.length).toBe(0);
  });
});
