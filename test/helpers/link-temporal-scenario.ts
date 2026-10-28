/**
 * Shared temporal-edge scenario: relationship state refresh and the liveness
 * filter, run against PGLite (test/link-relationships.test.ts) and Postgres
 * (test/e2e/link-relationships-postgres.test.ts).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { refreshRelationships, relationshipKeysForPages, staleRelationshipKeys } from '../../src/core/link-relationships.ts';
import { relationshipFilterSql, parseMultirange } from '../../src/core/link-validity.ts';

/** The caller owns the engine lifecycle (beforeAll connect / afterAll disconnect); `engineOf` returns it. */
export function defineLinkRelationshipTests(label: string, engineOf: () => BrainEngine, tag = 'lrt') {
  let eng: BrainEngine;
  const ids: Record<string, number> = {};
  const alice = `people/${tag}-alice-example`;
  const notes = `people/${tag}-private-notes`;
  const acme = `companies/${tag}-acme-example`;
  const widget = `companies/${tag}-widget-co`;
  const fund = `companies/${tag}-fund-a`;
  const newco = `companies/${tag}-new-co`;
  const short = (slug: string) => slug.replace(`${tag}-`, '');

  async function page(slug: string, type: string, frontmatter: Record<string, unknown> = {}) {
    await eng.putPage(slug, { type: type as never, title: slug, compiled_truth: `${slug} page.`, timeline: '', frontmatter });
    const [row] = await eng.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = $1 AND source_id = 'default'`, [slug]);
    ids[slug] = Number(row.id);
  }
  async function transition(from: string, to: string, type: string, kind: 'start' | 'end', on: string, origin: string | null) {
    await eng.executeRaw(
      `INSERT INTO link_transitions (source_id, from_page_id, to_page_id, link_type, kind, occurred_on, producer, origin_page_id)
       VALUES ('default', $1, $2, $3, $4, $5::date, 'timeline', $6)`,
      [ids[from], ids[to], type, kind, on, origin ? ids[origin] : null]);
  }
  async function liveTargets(from: string, opts: Parameters<typeof relationshipFilterSql>[1] = {}) {
    const rows = await eng.executeRaw<{ slug: string; link_type: string }>(
      `SELECT t.slug, l.link_type FROM links l JOIN pages t ON t.id = l.to_page_id
        WHERE l.from_page_id = $1 AND ${relationshipFilterSql('l', opts)} ORDER BY t.slug, l.link_type`, [ids[from]]);
    return [...new Set(rows.map(r => `${short(r.slug)}:${r.link_type}`))];
  }
  const key = (to: string, link_type: string) => ({ from_page_id: ids[alice], to_page_id: ids[to], link_type });

  describe(`link_relationships refresh (${label})`, () => {
    beforeAll(async () => {
      eng = engineOf();
      await page(alice, 'person');
      await page(notes, 'note', { visibility: 'private' });
      for (const c of [acme, widget, fund]) await page(c, 'company');
    });
    afterAll(async () => {
      await eng.executeRaw(`DELETE FROM pages WHERE slug LIKE $1`, [`%/${tag}-%`]);
    });

    test('schema objects exist after initSchema', async () => {
      const rows = await eng.executeRaw<{ t: string }>(
        `SELECT table_name AS t FROM information_schema.tables WHERE table_name IN ('link_transitions','link_relationships','link_edge_proposals') ORDER BY 1`);
      expect(rows.map(r => r.t)).toEqual(['link_edge_proposals', 'link_relationships', 'link_transitions']);
      const col = await eng.executeRaw(`SELECT 1 FROM information_schema.columns WHERE table_name = 'links' AND column_name = 'assertion_tense'`);
      expect(col.length).toBe(1);
    });

    test('a dated end on the person page closes an undated assertion from the company page', async () => {
      await eng.addLink(alice, acme, 'CTO of Acme', 'works_at', 'frontmatter', acme, 'key_people');
      await eng.addLink(alice, widget, 'joined Widget', 'works_at', 'markdown');
      await eng.addLink(alice, fund, 'invested in Fund A', 'invested_in', 'markdown');
      await transition(alice, acme, 'works_at', 'start', '2019-02-01', alice);
      await transition(alice, acme, 'works_at', 'end', '2025-03-01', alice);
      await transition(alice, widget, 'works_at', 'start', '2025-03-01', alice);
      const keys = await relationshipKeysForPages(eng, [ids[alice]]);
      expect(keys.length).toBe(3);
      expect(await refreshRelationships(eng, keys)).toBeGreaterThan(0);

      const [row] = await eng.executeRaw<{ valid_ranges: string; status_now: string; retired_at: unknown }>(
        `SELECT valid_ranges::text AS valid_ranges, status_now, retired_at FROM link_relationships
          WHERE from_page_id = $1 AND to_page_id = $2 AND scope = 'all'`, [ids[alice], ids[acme]]);
      expect(parseMultirange(row.valid_ranges)).toEqual([{ from: '2019-02-01', until: '2025-03-01' }]);
      expect(row.status_now).toBe('ended');
      expect(row.retired_at).not.toBeNull();

      expect(await liveTargets(alice)).toEqual(['companies/fund-a:invested_in', 'companies/widget-co:works_at']);
      expect(await liveTargets(alice, { asOf: '2022-06-01' })).toEqual(['companies/acme-example:works_at', 'companies/fund-a:invested_in']);
      expect(await liveTargets(alice, { status: 'ended' })).toEqual(['companies/acme-example:works_at']);
      expect(await liveTargets(alice, { during: { from: '2025-01-01', until: '2026-01-01' } }))
        .toEqual(['companies/acme-example:works_at', 'companies/fund-a:invested_in', 'companies/widget-co:works_at']);
      expect(await liveTargets(alice, { status: 'all' })).toHaveLength(3);
    });

    test('events are invisible before their dated occurrence', async () => {
      await transition(alice, fund, 'invested_in', 'start', '2023-01-01', alice);
      await refreshRelationships(eng, [key(fund, 'invested_in')]);
      expect(await liveTargets(alice, { asOf: '2022-06-01' })).toEqual(['companies/acme-example:works_at']);
    });

    test('private-origin evidence does not change the world-scope state', async () => {
      await eng.addLink(alice, widget, 'left Widget', 'works_at', 'manual-test', notes);
      await transition(alice, widget, 'works_at', 'end', '2026-01-15', notes);
      await refreshRelationships(eng, [key(widget, 'works_at')]);
      expect(await liveTargets(alice, { asOf: '2026-06-01' })).not.toContain('companies/widget-co:works_at');
      expect(await liveTargets(alice, { asOf: '2026-06-01', excludePrivate: true })).toContain('companies/widget-co:works_at');
    });

    test('a relationship without a state row reads as live; the stale sweep finds it', async () => {
      await page(newco, 'company');
      // A writer from before temporal state (raw insert, no refresh).
      await eng.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source) VALUES ($1, $2, 'advises', 'advisor to New Co', 'markdown')`, [ids[alice], ids[newco]]);
      expect(await liveTargets(alice)).toContain('companies/new-co:advises');
      const stale = await staleRelationshipKeys(eng, 5000);
      expect(stale.some(k => k.to_page_id === ids[newco])).toBe(true);
    });

    test('removing all evidence removes the state row', async () => {
      await refreshRelationships(eng, [key(newco, 'advises')]);
      await eng.removeLink(alice, newco, 'advises');
      await refreshRelationships(eng, [key(newco, 'advises')]);
      const rows = await eng.executeRaw('SELECT 1 FROM link_relationships WHERE to_page_id = $1', [ids[newco]]);
      expect(rows.length).toBe(0);
    });

    test('graph generation advances only on change', async () => {
      const before = await eng.executeRaw<{ v: string }>('SELECT last_value::text AS v FROM graph_generation_seq');
      expect(await refreshRelationships(eng, [key(acme, 'works_at')])).toBe(0);
      const after = await eng.executeRaw<{ v: string }>('SELECT last_value::text AS v FROM graph_generation_seq');
      expect(after[0].v).toBe(before[0].v);
    });
  });
}
