/**
 * Entity recall surfaces: the `entity` card's `referenced_by`,
 * `referenced_by_count` and `coverage`, entity resolution with derived
 * aliases, and get_backlinks' `type` / `group` / `limit` / `cursor`, through
 * MCP dispatch on PGLite.
 *
 * Protects: a brief can enumerate every page that names an account (grouped
 * by pack-canonical type, newest first, capped with an exact continuation);
 * remote callers never see or count private or derived-private referrers or
 * private fence text in previews; an exact title outranks a derived alias in
 * every reader; legacy get_backlinks calls keep their array; paging has no
 * duplicates or gaps; coverage states and their notices. Regression: a card
 * whose continuation disagrees with its group, a subject alias hijacking an
 * exact company name, a private memo leaking through `referenced_by`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { resolveEntitySlug } from '../src/core/entities/resolve.ts';
import { entityNames } from '../src/core/facts/capture-dedup.ts';
import { renderAction, cliRenderContext } from '../src/core/agent-output.ts';
import { mentionCoverageNotice } from '../src/core/mentions/coverage.ts';
import { linkEntityIdentity } from '../src/core/entity-identity.ts';
import { mentionBrain, page, resetMentionBrain, sweep } from './helpers/mention-brain.ts';

let engine: PGLiteEngine;
const config = { engine: 'pglite' } as never;
const local = { remote: false, sourceId: 'default', config };
const remote = { remote: true, transport: 'stdio' as const, sourceId: 'default', takesHoldersAllowList: ['world'], config };

beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetMentionBrain(engine); });

async function call(op: string, args: Record<string, unknown>, opts: Record<string, unknown> = local) {
  const r = await dispatchToolCall(engine, op, args, opts as never);
  return { result: r, json: r.isError ? null : JSON.parse(r.content[0].text), notices: r.content.slice(1).map(c => c.text) };
}

const account = () => page(engine, 'crm/123', 'crm', 'CRM record: Quormiro Capital', 'Account code: QUCO\nOwner: Dana Example');
async function tickets(n: number, opts: { type?: string } = {}) {
  for (let i = 0; i < n; i++) {
    await page(engine, `tickets/t${String(i).padStart(3, '0')}`, opts.type ?? 'ticket', `Ticket ${i}`,
      `Customer: QUCO Opened: 2026-01-${String((i % 28) + 1).padStart(2, '0')}\nStatus: ${i === 3 ? 'Open' : 'Closed'}`);
  }
}

describe('entity card referenced_by', () => {
  test('entity("QUCO") resolves the account; rows are grouped by canonical type, newest first, with previews', async () => {
    await account();
    await tickets(3);
    await page(engine, 'meetings/m1', 'meeting', 'Meeting: QUCO renewal prep', '# Meeting: QUCO renewal prep\n\nRenewal blocker: security review.');
    await sweep(engine);
    const { json } = await call('entity', { name: 'QUCO' });
    expect(json.card.entity.slug).toBe('crm/123');
    expect(json.card.referenced_by_count).toBe(4);
    expect(json.card.backlink_count).toBe(0);
    const groups = Object.fromEntries(json.card.referenced_by.map((g: { canonical_type: string }) => [g.canonical_type, g]));
    expect(groups.ticket.total).toBe(3);
    expect(groups.ticket.rows.map((r: { slug: string }) => r.slug)).toEqual(['tickets/t002', 'tickets/t001', 'tickets/t000']);
    expect(groups.ticket.rows[0]).toMatchObject({ title: 'Ticket 2', type: 'ticket', canonical_type: 'ticket', date_source: 'updated_at' });
    expect(groups.ticket.rows[0].preview).toBe('Customer: QUCO Opened: 2026-01-03 Status: Closed');
    expect(groups.meeting.rows[0].preview).toBe('Renewal blocker: security review.');
    expect(json.card.coverage).toEqual({ state: 'complete', pending_pages: 0, last_pass_at: expect.any(String) });
  });

  test('entity("Quormiro Capital") resolves a record whose slug is not the name', async () => {
    await account();
    await sweep(engine);
    expect((await call('entity', { name: 'Quormiro Capital' })).json.card.entity.slug).toBe('crm/123');
  });

  test('an exact company title outranks a CRM subject in entity, resolveEntitySlug and capture-dedup', async () => {
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
    await page(engine, 'crm/9', 'crm', 'CRM record: Acme Example', 'Account code: ACMX');
    await sweep(engine);
    expect((await call('entity', { name: 'Acme Example' })).json.card.entity.slug).toBe('companies/acme');
    expect(await resolveEntitySlug(engine, 'default', 'Acme Example')).toBe('companies/acme');
    expect(await engine.resolveAliases(['acme example'], { sourceId: 'default' })).toEqual(new Map());
    expect((await entityNames(engine, 'default', ['companies/acme'])).get('companies/acme')).toEqual(['Acme Example']);
  });

  test('crm pages group under the pack-canonical type account', async () => {
    await page(engine, 'people/dana', 'person', 'Dana Example', 'Owner.');
    await account();
    await sweep(engine);
    const { json } = await call('entity', { name: 'Dana Example' });
    expect(json.card.referenced_by.map((g: { canonical_type: string }) => g.canonical_type)).toEqual(['account']);
    expect(json.card.referenced_by[0].rows[0]).toMatchObject({ type: 'crm', canonical_type: 'account' });
  });

  test('a group capped at 10 rows carries its total and a get_backlinks continuation that reproduces the group', async () => {
    await account();
    await tickets(14);
    await sweep(engine);
    const card = (await call('entity', { name: 'QUCO' }, remote)).json.card;
    const group = card.referenced_by.find((g: { canonical_type: string }) => g.canonical_type === 'ticket');
    expect(group.total).toBe(14);
    expect(group.rows.length).toBe(10);
    expect(group.next).toMatchObject({ tool: 'get_backlinks', arguments: { slug: 'crm/123', source_id: 'default', type: 'ticket', group: 'page', limit: 50 } });
    const rest = (await call('get_backlinks', group.next.arguments, remote)).json;
    expect(rest.total).toBe(14);
    expect(rest.truncated).toBe(false);
    const { cursor: _c, ...fromStart } = group.next.arguments;
    const all = (await call('get_backlinks', fromStart, remote)).json;
    expect(all.total).toBe(14);
    expect(all.rows.slice(0, 10).map((r: { slug: string }) => r.slug)).toEqual(group.rows.map((r: { slug: string }) => r.slug));
    expect([...group.rows, ...rest.rows].map((r: { slug: string }) => r.slug)).toEqual(all.rows.map((r: { slug: string }) => r.slug));
  });

  test('the whole card holds at most 50 rows across groups; every group keeps rows and a continuation', async () => {
    await account();
    for (const type of ['ticket', 'email', 'meeting', 'note', 'contract', 'invoice', 'call']) await tickets(9, { type });
    await engine.executeRaw(`UPDATE pages SET slug = slug || '-' || type WHERE type <> 'crm'`);
    await sweep(engine);
    const card = (await call('entity', { name: 'QUCO' })).json.card;
    expect(card.referenced_by_count).toBe(9);
    expect(card.referenced_by.reduce((n: number, g: { rows: unknown[] }) => n + g.rows.length, 0)).toBeLessThanOrEqual(50);
  });

  test('remote callers: a private memo, a digest derived from it, an atom and a synthesized concept neither appear nor count; previews drop private fences', async () => {
    await account();
    await page(engine, 'notes/public', 'note', 'Public', 'QUCO renewal is on track.\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|\n| 1 | SECRETFACT churn risk | fact | 1.0 | private | medium | 2026-01-01 |  | test |  |\n<!--- gbrain:facts:end -->');
    await page(engine, 'notes/memo', 'note', 'Board memo', 'QUCO layoffs MEMOMARKER.', { frontmatter: { visibility: 'private' } });
    await page(engine, 'notes/digest', 'note', 'Digest', 'Summary of the QUCO memo DIGESTMARKER.', { frontmatter: { derived_from: 'notes/memo' } });
    await page(engine, 'atoms/a1', 'atom', 'Atom', 'QUCO ATOMMARKER.');
    await page(engine, 'concepts/c1', 'concept', 'Concept', 'QUCO CONCEPTMARKER.', { frontmatter: { synthesized_by: 'dream' } });
    await sweep(engine);
    const remoteText = (await dispatchToolCall(engine, 'entity', { name: 'QUCO' }, remote as never)).content[0].text;
    for (const marker of ['notes/memo', 'MEMOMARKER', 'notes/digest', 'DIGESTMARKER', 'ATOMMARKER', 'CONCEPTMARKER', 'SECRETFACT']) expect(remoteText).not.toContain(marker);
    expect(JSON.parse(remoteText).card.referenced_by_count).toBe(1);
    const page1 = (await call('get_backlinks', { slug: 'crm/123', group: 'page' }, remote)).json;
    expect(page1.total).toBe(1);
    expect(JSON.stringify(page1)).not.toContain('SECRETFACT');
    expect((await call('entity', { name: 'QUCO' })).json.card.referenced_by_count).toBe(5);
  });

  test('context_pack does not compute referenced_by (ambient callers stay cheap)', async () => {
    await account();
    await tickets(2);
    await sweep(engine);
    const card = (await buildEntityCard(engine, 'default', 'QUCO', { remote: false })).card!;
    expect(card.referenced_by).toBeUndefined();
    expect(card.coverage).toBeUndefined();
    const pack = (await call('context_pack', { entities: 'QUCO' })).result.content[0].text;
    expect(pack).not.toContain('referenced_by');
  });

  test('on the verbs surface a continuation names the starter surface', async () => {
    await account();
    await tickets(12);
    await sweep(engine);
    const card = (await buildEntityCard(engine, 'default', 'QUCO', { remote: true, includeReferences: true, surfaceCeiling: 'verbs' })).card!;
    expect(card.referenced_by!.find(g => g.canonical_type === 'ticket')!.next!.requires_surface).toBe('starter');
  });
});

describe('coverage states', () => {
  test('pending on a miss before any pass, with a notice whose fix the local CLI runs and a remote agent relays', async () => {
    await account();
    const { json, notices } = await call('entity', { name: 'cat40 coverage probe' }, remote);
    expect(json.found).toBe(false);
    expect(json.coverage).toMatchObject({ state: 'pending', pending_pages: 1, degraded: true });
    expect(notices.join('\n')).toContain('[gbrain notice mention_index');
    const notice = mentionCoverageNotice(json.coverage)!;
    expect(renderAction(notice.fix!, cliRenderContext()).next).toBe('run');
    expect(notices.join('\n')).toContain('tell_user_to_run');
  });

  test('complete after a sweep; disabled when off; failed after a failed pass; type_not_linkable on a non-entity card', async () => {
    await account();
    await page(engine, 'projects/apollo', 'project', 'Project Apollo', 'Mentions QUCO.');
    await sweep(engine);
    expect((await call('entity', { name: 'cat40 coverage probe' })).json.coverage.state).toBe('complete');
    const proj = (await call('entity', { name: 'Project Apollo' }, remote));
    expect(proj.json.card.coverage.state).toBe('type_not_linkable');
    expect(proj.notices.join('\n')).toContain('mentions.entity_types');
    await engine.executeRaw("UPDATE mention_index_status SET state = 'failed', error = 'x'");
    expect((await call('entity', { name: 'QUCO' }, remote)).json.card.coverage.state).toBe('failed');
    await engine.setConfig('mentions.auto_link', 'false');
    const off = await call('entity', { name: 'QUCO' }, remote);
    expect(off.json.card.coverage).toMatchObject({ state: 'disabled', degraded: true });
    expect(off.notices.join('\n')).toContain('mentions.auto_link');
  });
});

describe('get_backlinks', () => {
  test('without the new parameters the response is the unchanged link array', async () => {
    await account();
    await tickets(2);
    await sweep(engine);
    const { json } = await call('get_backlinks', { slug: 'crm/123' });
    expect(Array.isArray(json)).toBe(true);
    expect(json).toEqual(await engine.getBacklinks('crm/123', { sourceId: 'default' }));
  });

  test('type filters the array mode; a limit cut names the paged call', async () => {
    await account();
    await tickets(3);
    await page(engine, 'meetings/m1', 'meeting', 'Meeting: QUCO', 'x');
    await sweep(engine);
    const meetings = (await call('get_backlinks', { slug: 'crm/123', type: 'meeting' })).json;
    expect(meetings.map((l: { from_slug: string }) => l.from_slug)).toEqual(['meetings/m1']);
    const cut = await call('get_backlinks', { slug: 'crm/123', limit: 2 }, remote);
    expect(cut.json.length).toBe(2);
    expect(cut.notices.join('\n')).toContain('listing_truncated');
  });

  test('limit over 500 and an unknown type are agent-operator errors naming the valid values', async () => {
    await account();
    await tickets(1);
    await sweep(engine);
    const big = await call('get_backlinks', { slug: 'crm/123', group: 'page', limit: 501 });
    expect(big.result.isError).toBe(true);
    expect(big.result.content[0].text).toContain('1 to 500');
    const bad = await call('get_backlinks', { slug: 'crm/123', type: 'bogus' });
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0].text).toContain('ticket');
  });

  test('pack aliases and observed types are accepted; untyped pages group as untyped', async () => {
    await page(engine, 'people/dana', 'person', 'Dana Example', 'x');
    await account();
    await page(engine, 'misc/raw', '', 'Raw', 'Dana Example called.');
    await sweep(engine);
    expect((await call('get_backlinks', { slug: 'people/dana', group: 'page', type: 'crm' })).json.rows[0].canonical_type).toBe('account');
    expect((await call('get_backlinks', { slug: 'people/dana', group: 'page', type: 'account' })).json.total).toBe(1);
    const card = (await call('entity', { name: 'Dana Example' })).json.card;
    expect(card.referenced_by.map((g: { canonical_type: string }) => g.canonical_type).sort()).toEqual(['account', 'untyped']);
    expect((await call('get_backlinks', { slug: 'people/dana', group: 'page', type: 'untyped' })).json.rows[0].slug).toBe('misc/raw');
  });

  test('identity union: off counts the page alone; on, the card and its continuation both include co-member referrers', async () => {
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'x');
    await page(engine, 'companies/acme-inc', 'company', 'Acme Incorporated', 'x');
    await page(engine, 'notes/a', 'note', 'a', 'Acme Example signed.');
    await page(engine, 'notes/b', 'note', 'b', 'Acme Incorporated paid.');
    await sweep(engine);
    await linkEntityIdentity(engine, { entityId: 'acme-group', slug: 'companies/acme', sourceId: 'default' });
    await linkEntityIdentity(engine, { entityId: 'acme-group', slug: 'companies/acme-inc', sourceId: 'default' });
    const counts = async () => [
      (await call('entity', { name: 'companies/acme' })).json.card.referenced_by_count,
      (await call('get_backlinks', { slug: 'companies/acme', group: 'page' })).json.total,
    ];
    expect(await counts()).toEqual([1, 1]);
    await engine.setConfig('entity_identity.union', 'true');
    expect(await counts()).toEqual([2, 2]);
  });

  test('more than 500 referrers across two sources with equal dates page without duplicates or gaps', async () => {
    await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT DO NOTHING");
    await page(engine, 'people/hub', 'person', 'Hub Person', 'x');
    const [hub] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE slug = 'people/hub'");
    // Same slugs in both sources, one shared date: order falls to (source_id, slug).
    for (const source of ['default', 'other']) {
      await engine.executeRaw(
        `INSERT INTO pages (source_id, slug, type, title, compiled_truth, updated_at)
         SELECT $1, 'notes/r' || lpad(g::text, 4, '0'), 'note', 'R' || g, 'x', '2026-01-01T00:00:00Z' FROM generate_series(1, 300) g`, [source]);
      await engine.executeRaw(
        `INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
         SELECT p.id, $2, 'mentions', 'mentions' FROM pages p WHERE p.source_id = $1 AND p.slug LIKE 'notes/r%'`, [source, hub.id]);
    }
    const scope = { remote: false, config, sourceId: 'default' };
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) {
      const { json } = await call('get_backlinks', { slug: 'people/hub', all_sources: true, group: 'page', limit: 137, ...(cursor ? { cursor } : {}) }, scope);
      expect(json.total).toBe(600);
      seen.push(...json.rows.map((r: { source_id: string; slug: string }) => `${r.source_id}:${r.slug}`));
      if (!json.truncated) break;
      cursor = json.cursor;
    }
    expect(seen.length).toBe(600);
    expect(new Set(seen).size).toBe(600);
  });
});
