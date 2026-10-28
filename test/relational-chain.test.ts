/**
 * Multi-hop relational chains (PGLite): readChainHop orientation + policy and
 * runRelationalChain path semantics.
 *
 * Protects: a two-relation question ("who founded the companies Alice invested
 * in?") walks typed edges stored from either page's side; private, deleted and
 * non-entity pages never become hops or move scores; the anchor is an answer
 * unless the plan excludes it; caps bound work and are reported.
 * Regression it catches: walking stored direction only (misses company-page
 * edges), global earlier-hop exclusion, ranking through hidden nodes,
 * unbounded hub expansion.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runRelationalChain, linkFamily, type ChainAnchor, type ChainPlan } from '../src/core/search/relational-chain.ts';
import { QUARANTINE_KEY } from '../src/core/quarantine.ts';

let eng: PGLiteEngine;

async function anchor(slug: string): Promise<ChainAnchor> {
  const rows = await eng.executeRaw<{ id: number; source_id: string }>(`SELECT id, source_id FROM pages WHERE slug = $1`, [slug]);
  return { page_id: Number(rows[0].id), slug, source_id: rows[0].source_id };
}

const investedThenFounders: ChainPlan = {
  hops: [{ linkTypes: linkFamily('invested_in'), toward: 'object' }, { linkTypes: ['founded'], toward: 'subject' }],
  excludeAnchor: false,
};

beforeAll(async () => {
  eng = new PGLiteEngine();
  await eng.connect({});
  await eng.initSchema();
  const pages: Array<[string, string, Record<string, unknown>?]> = [
    ['people/alice-example', 'person'], ['people/bob-example', 'person'], ['people/carol-example', 'person'],
    ['people/dave-example', 'person'], ['people/priv-example', 'person', { visibility: 'private' }],
    ['people/gone-example', 'person'], ['companies/acme-example', 'company'], ['companies/beta-example', 'company'],
    ['companies/gamma-example', 'company'], ['companies/fund-x-example', 'company'], ['notes/memo-example', 'note'],
    ['companies/empty-example', 'company'],
  ];
  for (const [slug, type, frontmatter] of pages) {
    await eng.putPage(slug, { type: type as 'person', title: slug.split('/')[1], compiled_truth: `${slug} body`, timeline: '', ...(frontmatter ? { frontmatter } : {}) });
  }
  const md = async (from: string, to: string, type: string, context = '') => eng.addLink(from, to, context, type, 'markdown');
  await md('people/alice-example', 'companies/acme-example', 'invested_in', 'alice backed acme');
  await md('companies/acme-example', 'people/alice-example', 'invested_in', 'investors include alice');
  await md('companies/beta-example', 'people/alice-example', 'invested_in', 'beta investors: alice');
  await md('companies/acme-example', 'people/bob-example', 'founded', 'founded by bob');
  await md('people/carol-example', 'companies/beta-example', 'founded', 'carol founded beta');
  await md('people/dave-example', 'companies/acme-example', 'invested_in');
  await md('people/dave-example', 'companies/beta-example', 'led_round');
  await md('companies/fund-x-example', 'companies/acme-example', 'invested_in', 'fund x backed acme');
  await md('notes/memo-example', 'people/alice-example', 'invested_in');
  await md('people/priv-example', 'companies/acme-example', 'founded');
  await md('people/gone-example', 'companies/acme-example', 'founded');
  await md('people/alice-example', 'companies/gamma-example', 'founded');
  await md('people/alice-example', 'companies/gamma-example', 'invested_in');
  await eng.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'people/gone-example'`);
}, 60_000);

afterAll(async () => {
  await eng.disconnect();
});

describe('readChainHop', () => {
  test('orients rows stored from either side and collapses duplicates into one logical edge', async () => {
    const a = await anchor('people/alice-example');
    const edges = await eng.relationalChainHop([a.page_id], {
      linkTypes: linkFamily('invested_in'), toward: 'object', subjectTypes: ['company', 'person'],
      objectTypes: ['company', 'deal'], degreeLinkTypes: ['invested_in', 'founded'], neighborCap: 100,
    });
    const bySlug = Object.fromEntries(edges.map(e => [e.to_slug, e]));
    expect(Object.keys(bySlug).sort()).toEqual(['companies/acme-example', 'companies/beta-example', 'companies/gamma-example']);
    expect(bySlug['companies/acme-example'].link_ids.length).toBe(2);
    expect(bySlug['companies/acme-example'].orientation).toBe('stored');
    expect(bySlug['companies/beta-example'].orientation).toBe('flipped');
    expect(bySlug['companies/beta-example'].stored_from_slug).toBe('companies/beta-example');
  });

  test('company↔company edges are uncertain and walk stored direction only; non-entity pages are not hops', async () => {
    const acme = await anchor('companies/acme-example');
    const edges = await eng.relationalChainHop([acme.page_id], {
      linkTypes: linkFamily('invested_in'), toward: 'subject', subjectTypes: ['company', 'person'],
      objectTypes: ['company', 'deal'], degreeLinkTypes: ['invested_in'], neighborCap: 100,
    });
    const fund = edges.find(e => e.to_slug === 'companies/fund-x-example');
    expect(fund?.orientation).toBe('uncertain');
    const alice = await anchor('people/alice-example');
    const fromAlice = await eng.relationalChainHop([alice.page_id], {
      linkTypes: linkFamily('invested_in'), toward: 'subject', subjectTypes: ['company', 'person'],
      objectTypes: ['company', 'deal'], degreeLinkTypes: ['invested_in'], neighborCap: 100,
    });
    expect(fromAlice.map(e => e.to_slug)).not.toContain('notes/memo-example');
  });
});

describe('runRelationalChain', () => {
  test('who founded the companies alice invested in', async () => {
    const { rows, diagnostics } = await runRelationalChain(eng, [await anchor('people/alice-example')], investedThenFounders, {});
    const answers = rows.filter(r => r.role === 'answer').map(r => r.slug);
    expect(answers.sort()).toEqual(['people/alice-example', 'people/bob-example', 'people/carol-example', 'people/priv-example']);
    expect(rows.filter(r => r.role === 'support').map(r => r.slug).sort())
      .toEqual(['companies/acme-example', 'companies/beta-example', 'companies/gamma-example']);
    expect(diagnostics.status).toBe('fired');
    const bob = rows.find(r => r.slug === 'people/bob-example')!;
    expect(bob.best_path.nodes).toEqual(['people/alice-example', 'companies/acme-example', 'people/bob-example']);
    expect(bob.best_path.edges[1]).toMatchObject({ link_type: 'founded', orientation: 'flipped', context: 'founded by bob' });
  });

  test('deleted pages never answer; private pages are hidden under excludePrivate without moving scores', async () => {
    const a = await anchor('people/alice-example');
    const open = await runRelationalChain(eng, [a], investedThenFounders, {});
    expect(open.rows.map(r => r.slug)).not.toContain('people/gone-example');
    expect(open.rows.map(r => r.slug)).toContain('people/priv-example');
    const scoped = await runRelationalChain(eng, [a], investedThenFounders, { excludePrivate: true });
    expect(scoped.rows.map(r => r.slug)).not.toContain('people/priv-example');
    const bob = (rs: typeof open.rows) => rs.find(r => r.slug === 'people/bob-example')!.score;
    await eng.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'people/priv-example'`);
    const without = await runRelationalChain(eng, [a], investedThenFounders, { excludePrivate: true });
    await eng.executeRaw(`UPDATE pages SET deleted_at = NULL WHERE slug = 'people/priv-example'`);
    expect(bob(scoped.rows)).toBe(bob(without.rows));
  });

  test('co-investors exclude the anchor; a relation family merges led_round', async () => {
    const plan: ChainPlan = {
      hops: [{ linkTypes: linkFamily('invested_in'), toward: 'object' }, { linkTypes: linkFamily('invested_in'), toward: 'subject' }],
      excludeAnchor: true,
    };
    const { rows } = await runRelationalChain(eng, [await anchor('people/alice-example')], plan, {});
    const answers = rows.filter(r => r.role === 'answer');
    expect(answers.map(r => r.slug)).not.toContain('people/alice-example');
    const dave = answers.find(r => r.slug === 'people/dave-example')!;
    expect(dave.path_count).toBe(2);
    expect(answers[0].slug).toBe('people/dave-example');
    const fund = answers.find(r => r.slug === 'companies/fund-x-example')!;
    expect(fund.score).toBeLessThan(dave.score);
  });

  test('the anchor can be an answer when the plan does not exclude it', async () => {
    const plan: ChainPlan = {
      hops: [{ linkTypes: ['founded'], toward: 'object' }, { linkTypes: linkFamily('invested_in'), toward: 'subject' }],
      excludeAnchor: false,
    };
    const { rows } = await runRelationalChain(eng, [await anchor('people/alice-example')], plan, {});
    expect(rows.filter(r => r.role === 'answer').map(r => r.slug)).toContain('people/alice-example');
  });

  test('empty first hop is no_edges; empty later hop is empty_hop with its index', async () => {
    const empty = await runRelationalChain(eng, [await anchor('companies/empty-example')], {
      hops: [{ linkTypes: ['founded'], toward: 'subject' }, { linkTypes: linkFamily('invested_in'), toward: 'object' }], excludeAnchor: false,
    }, {});
    expect(empty.diagnostics.status).toBe('no_edges');
    const later = await runRelationalChain(eng, [await anchor('people/bob-example')], {
      hops: [{ linkTypes: ['founded'], toward: 'object' }, { linkTypes: ['advises'], toward: 'subject' }], excludeAnchor: false,
    }, {});
    expect(later.diagnostics).toMatchObject({ status: 'empty_hop', empty_hop: 2 });
    const none = await runRelationalChain(eng, [], investedThenFounders, {});
    expect(none.diagnostics.status).toBe('anchor_not_found');
  });

  test('identical inputs give identical output (order, scores, paths)', async () => {
    const a = await anchor('people/alice-example');
    const one = await runRelationalChain(eng, [a], investedThenFounders, {});
    const two = await runRelationalChain(eng, [a], investedThenFounders, {});
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
  });
});

describe('path-local cycles and self-links', () => {
  let c: PGLiteEngine;

  beforeAll(async () => {
    c = new PGLiteEngine();
    await c.connect({});
    await c.initSchema();
    for (const [slug, type] of [['people/a-example', 'person'], ['companies/b-example', 'company'], ['people/c-example', 'person'],
      ['companies/d-example', 'company']] as const) {
      await c.putPage(slug, { type, title: slug, compiled_truth: slug, timeline: '' });
    }
    const md = (f: string, t: string, lt: string) => c.addLink(f, t, '', lt, 'markdown');
    await md('people/a-example', 'companies/b-example', 'invested_in');
    await md('people/c-example', 'companies/b-example', 'invested_in');
    await md('people/a-example', 'companies/d-example', 'invested_in');
    await md('people/c-example', 'companies/d-example', 'invested_in');
    await md('people/a-example', 'people/a-example', 'invested_in');
  }, 60_000);

  afterAll(async () => {
    await c.disconnect();
  });

  test('a path never revisits its own node; another path may reach it', async () => {
    const id = Number((await c.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'people/a-example'`))[0].id);
    const plan: ChainPlan = {
      hops: [{ linkTypes: ['invested_in'], toward: 'object' }, { linkTypes: ['invested_in'], toward: 'subject' }, { linkTypes: ['invested_in'], toward: 'object' }],
      excludeAnchor: true,
    };
    const { rows } = await runRelationalChain(c, [{ page_id: id, slug: 'people/a-example', source_id: 'default' }], plan, {});
    // A→B→C→B revisits B on its own path and is dropped; A→D→C→B is a fresh path and keeps B.
    const b = rows.find(r => r.role === 'answer' && r.slug === 'companies/b-example')!;
    expect(b.best_path.nodes).toEqual(['people/a-example', 'companies/d-example', 'people/c-example', 'companies/b-example']);
    expect(b.path_count).toBe(1);
    for (const r of rows) {
      expect(new Set(r.best_path.nodes).size).toBe(r.best_path.nodes.length);
      expect(r.best_path.edges.every(e => e.stored_from !== e.stored_to)).toBe(true);
    }
  });
});

describe('bounds', () => {
  test('a hub with more neighbors than neighborCap is capped and reported', async () => {
    await eng.executeRaw(`INSERT INTO pages (slug, type, title, compiled_truth, timeline, source_id)
      SELECT 'people/hub-investor-' || g, 'person', 'hub investor ' || g, '', '', 'default' FROM generate_series(1, 400) g`);
    await eng.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source)
      SELECT p.id, c.id, 'invested_in', '', 'markdown' FROM pages p, pages c
      WHERE p.slug LIKE 'people/hub-investor-%' AND c.slug = 'companies/beta-example'`);
    const { rows, diagnostics } = await runRelationalChain(eng, [await anchor('people/carol-example')], {
      hops: [{ linkTypes: ['founded'], toward: 'object' }, { linkTypes: linkFamily('invested_in'), toward: 'subject' }], excludeAnchor: false,
    }, {}, { frontierCap: 50, neighborCap: 100, pathsPerNode: 10, hubWeighting: true });
    expect(rows.filter(r => r.role === 'answer').length).toBeLessThanOrEqual(100);
    expect(diagnostics.cap_hit).toEqual({ cap: 'neighbor', hop: 2 });
    expect(diagnostics.status).toBe('truncated');
  });
});

/**
 * Release gate: a node the caller may not read changes nothing it could
 * observe. Each case compares a chain over a graph holding one hidden element
 * (private, quarantined or other-source intermediate; hidden
 * degree contributor; link written on a hidden origin page) against the same
 * chain after that element is physically removed: answers, scores, path
 * counts, best paths and diagnostics must be identical.
 */
describe('hidden-node invariance', () => {
  let h: PGLiteEngine;
  const plan: ChainPlan = {
    hops: [{ linkTypes: linkFamily('invested_in'), toward: 'object' }, { linkTypes: ['founded'], toward: 'subject' }],
    excludeAnchor: false,
  };
  const policy = { excludePrivate: true, sourceId: 'default' };

  async function chain(scope: { excludePrivate?: boolean; sourceId?: string } = policy) {
    const rows = await h.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'people/ann-example' AND source_id = 'default'`);
    const out = await runRelationalChain(h, [{ page_id: Number(rows[0].id), slug: 'people/ann-example', source_id: 'default' }], plan, scope);
    return JSON.stringify({
      rows: out.rows.map(r => ({ slug: r.slug, role: r.role, score: r.score, path_count: r.path_count, nodes: r.best_path.nodes })),
      diagnostics: out.diagnostics,
    });
  }

  beforeAll(async () => {
    h = new PGLiteEngine();
    await h.connect({});
    await h.initSchema();
    await h.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT (id) DO NOTHING`);
    for (const [slug, type] of [['people/ann-example', 'person'], ['people/ben-example', 'person'], ['people/cy-example', 'person'],
      ['companies/open-example', 'company'], ['companies/two-example', 'company']] as const) {
      await h.putPage(slug, { type, title: slug, compiled_truth: slug, timeline: '' });
    }
    await h.addLink('people/ann-example', 'companies/open-example', '', 'invested_in', 'markdown');
    await h.addLink('people/ann-example', 'companies/two-example', '', 'invested_in', 'markdown');
    await h.addLink('companies/open-example', 'people/ben-example', 'founded by ben', 'founded', 'markdown');
    await h.addLink('people/cy-example', 'companies/two-example', '', 'founded', 'markdown');
    await h.addLink('people/cy-example', 'companies/open-example', '', 'invested_in', 'markdown');
  }, 60_000);

  afterAll(async () => {
    await h.disconnect();
  });

  const hiddenCompany = async (slug: string, frontmatter: Record<string, unknown>, sourceId = 'default') => {
    await h.putPage(slug, { type: 'company', title: slug, compiled_truth: slug, timeline: '', frontmatter }, { sourceId } as never);
    await h.putPage('people/zed-example', { type: 'person', title: 'zed', compiled_truth: 'zed', timeline: '' }, { sourceId } as never);
    await h.addLink('people/ann-example', slug, '', 'invested_in', 'markdown', undefined, undefined, { toSourceId: sourceId });
    await h.addLink(slug, 'people/zed-example', '', 'founded', 'markdown', undefined, undefined, { fromSourceId: sourceId, toSourceId: sourceId });
  };
  const purge = async (...slugs: string[]) => {
    await h.executeRaw(`DELETE FROM links WHERE from_page_id IN (SELECT id FROM pages WHERE slug = ANY($1::text[]))
      OR to_page_id IN (SELECT id FROM pages WHERE slug = ANY($1::text[]))`, [slugs]);
    await h.executeRaw(`DELETE FROM pages WHERE slug = ANY($1::text[])`, [slugs]);
  };

  test('private, quarantined and archived-source intermediates', async () => {
    const clean = await chain();
    await hiddenCompany('companies/priv-example', { visibility: 'private' });
    expect(await chain({ sourceId: 'default' })).toContain('people/zed-example');
    expect(await chain()).toBe(clean);
    await purge('companies/priv-example', 'people/zed-example');
    await hiddenCompany('companies/quar-example', { [QUARANTINE_KEY]: { reason: 'test' } });
    expect(await chain()).toBe(clean);
    await purge('companies/quar-example', 'people/zed-example');
    expect(await chain()).toBe(clean);
  });

  test('a hidden degree contributor does not move scores', async () => {
    const clean = await chain();
    for (let i = 0; i < 5; i++) {
      await h.putPage(`people/shadow-${i}-example`, { type: 'person', title: 's', compiled_truth: 's', timeline: '', frontmatter: { visibility: 'private' } });
      await h.addLink(`people/shadow-${i}-example`, 'companies/open-example', '', 'invested_in', 'markdown');
    }
    expect(await chain({ sourceId: 'default' })).not.toBe(clean);
    expect(await chain()).toBe(clean);
    await purge(...Array.from({ length: 5 }, (_, i) => `people/shadow-${i}-example`));
  });

  test('a link written on a hidden origin page is not walked and does not count toward degree', async () => {
    const clean = await chain();
    await h.putPage('meetings/secret-example', { type: 'meeting', title: 'm', compiled_truth: 'm', timeline: '', frontmatter: { visibility: 'private' } });
    await h.putPage('people/dee-example', { type: 'person', title: 'dee', compiled_truth: 'dee', timeline: '' });
    await h.addLink('companies/two-example', 'people/dee-example', '', 'founded', 'markdown', 'meetings/secret-example', 'body');
    await h.addLink('people/dee-example', 'companies/open-example', '', 'invested_in', 'markdown', 'meetings/secret-example', 'body');
    expect(await chain()).toBe(clean);
    await purge('meetings/secret-example', 'people/dee-example');
  });

  test('a cross-source edge is not followed', async () => {
    const clean = await chain();
    await hiddenCompany('companies/far-example', {}, 'other');
    expect((await h.executeRaw<{ source_id: string }>(`SELECT source_id FROM pages WHERE slug = 'companies/far-example'`))[0].source_id).toBe('other');
    expect(await chain({})).toBe(clean);
    await purge('companies/far-example', 'people/zed-example');
  });
});
