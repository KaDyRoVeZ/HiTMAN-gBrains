/**
 * #7159: the frontmatter equality filter on search, query and list_pages
 * (`where` over MCP, `--where key=value` on the CLI), and the one filter
 * hint a search/query carries when it looks like it wanted a filter.
 *
 * PGLite; the same scenarios run on Postgres in
 * test/e2e/search-frontmatter-where-parity.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { parseOpArgs } from '../src/cli/main.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { frontmatterWhereClauses, parseFrontmatterWhere } from '../src/core/search/frontmatter-where.ts';
import { filterHint } from '../src/core/search/filter-hint.ts';
import { searchCtx } from './helpers/keyword-paging-fixture.ts';
import { PRIVATE_WHERE, PRIVATE_WHERE_LOCAL, PRIVATE_WHERE_REMOTE, TERM, WHERE_CASES, seedFrontmatterCorpus } from './helpers/frontmatter-where-fixture.ts';

let engine: PGLiteEngine;
const op = (name: string) => operations.find(o => o.name === name)!;

async function run(name: string, params: Record<string, unknown>, remote: boolean): Promise<{ slugs: string[]; notices: Notice[] }> {
  const notices: Notice[] = [];
  const ctx = { ...searchCtx(engine, remote), emitNotice: (n: Notice) => { notices.push(n); } };
  const rows = await op(name).handler(ctx as never, params) as Array<{ slug: string }>;
  return { slugs: [...new Set(rows.map(r => r.slug))].sort(), notices };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedFrontmatterCorpus(engine);
}, 120_000);

afterAll(async () => { await engine.disconnect(); });

describe('where filter (#7159)', () => {
  for (const [label, where, expected] of WHERE_CASES) {
    test(`remote search, query and list_pages agree: ${label}`, async () => {
      expect((await run('search', { query: TERM, where }, true)).slugs).toEqual(expected);
      expect((await run('query', { query: TERM, where, expand: false }, true)).slugs).toEqual(expected);
      expect((await run('list_pages', { where }, true)).slugs).toEqual(expected);
    });
  }

  test('keyword-mode search pages the filtered set', async () => {
    expect((await run('search', { query: TERM, where: { stage: 'seed' }, match: 'keyword' }, true)).slugs).toEqual(['deals/acme-example', 'deals/gamma-example']);
  });

  test('a remote caller never sees a private page through the filter; the local CLI does', async () => {
    const where = PRIVATE_WHERE;
    expect((await run('search', { query: TERM, where }, true)).slugs).toEqual(PRIVATE_WHERE_REMOTE);
    expect((await run('query', { query: TERM, where, expand: false }, true)).slugs).toEqual(PRIVATE_WHERE_REMOTE);
    expect((await run('list_pages', { where }, true)).slugs).toEqual(PRIVATE_WHERE_REMOTE);
    expect((await run('search', { query: TERM, where }, false)).slugs).toEqual(PRIVATE_WHERE_LOCAL);
    expect((await run('list_pages', { where }, false)).slugs).toEqual(PRIVATE_WHERE_LOCAL);
  });

  test('list_pages where composes with type, updated_after and sort', async () => {
    const rows = await op('list_pages').handler(searchCtx(engine, true) as never, { type: 'deal', where: { stage: 'seed' }, sort: 'slug', updated_after: '2000-01-01' }) as Array<{ slug: string }>;
    expect(rows.map(r => r.slug)).toEqual(['deals/acme-example', 'deals/gamma-example']);
  });

  test('list_pages slug_prefix is a literal prefix, composes with type, where and sort, and stays private-filtered', async () => {
    expect((await run('list_pages', { slug_prefix: 'deals/' }, true)).slugs).toEqual(['deals/acme-example', 'deals/beta-example', 'deals/gamma-example']);
    expect((await run('list_pages', { slug_prefix: 'deals/' }, false)).slugs).toContain('deals/private-example');
    expect((await run('list_pages', { slug_prefix: 'deal%' }, true)).slugs).toEqual([]);
    expect((await run('list_pages', { slug_prefix: 'deals_' }, true)).slugs).toEqual([]);
    const ctx = searchCtx(engine, true);
    const rows = await op('list_pages').handler(ctx as never, { type: 'deal', slug_prefix: 'deals/', where: { stage: 'seed' }, sort: 'slug', updated_after: '2000-01-01' }) as Array<{ slug: string }>;
    expect(rows.map(r => r.slug)).toEqual(['deals/acme-example', 'deals/gamma-example']);
    expect(parseOpArgs(op('list_pages') as never, ['--slug-prefix', 'deals/', '--sort', 'slug']).slug_prefix).toBe('deals/');
  });

  test('an invalid key or value is invalid_params on every op', async () => {
    for (const name of ['search', 'query', 'list_pages']) {
      for (const where of [{ 'bad key': 'x' }, { "k'); DROP TABLE pages; --": 'x' }, { stage: [] }, { stage: { nested: 1 } }, 'stage=seed', ['stage']]) {
        await expect(op(name).handler(searchCtx(engine, true) as never, { query: TERM, where })).rejects.toMatchObject({ code: 'invalid_params' });
      }
    }
  });

  test('values are bound parameters and keys travel only inside the bound JSON', () => {
    const params: string[] = [];
    const clauses = frontmatterWhereClauses('p', parseFrontmatterWhere({ stage: "seed'--" }), json => `$${params.push(json)}`);
    expect(clauses).toEqual(['AND (p.frontmatter @> $1::text::jsonb OR p.frontmatter @> $2::text::jsonb)']);
    expect(params.map(p => JSON.parse(p))).toEqual([{ stage: "seed'--" }, { stage: ["seed'--"] }]);
  });
});

describe('CLI parsing', () => {
  test('--where key=value repeats, key=a,b is a list, a repeated key merges', () => {
    expect(parseOpArgs(op('search') as never, ['q', '--where', 'stage=seed,series-a', '--where', 'partner=alice-example', '--where=stage=growth']).where)
      .toEqual({ stage: ['seed', 'series-a', 'growth'], partner: 'alice-example' });
    expect(parseOpArgs(op('list_pages') as never, ['--where', '{"stage":"seed"}']).where).toEqual({ stage: 'seed' });
    expect(parseOpArgs(op('query') as never, ['q', '--where', 'stage=seed']).where).toEqual({ stage: 'seed' });
    expect(() => parseOpArgs(op('query') as never, ['q', '--where', 'stage'])).toThrow('--where takes key=value');
  });
});

describe('filter hint', () => {
  const hint = (notices: Notice[]) => notices.find(n => n.code === 'search_filter_hint');

  test('a query naming a page type gets one hint naming types, and the same results', async () => {
    const hinted = await run('search', { query: `${TERM} meetings` }, true);
    const h = hint(hinted.notices);
    expect(h?.why).toContain('types: ["meeting"]');
    expect(h?.fix?.argv).toEqual(['gbrain', 'search', `${TERM} meetings`, '--types', 'meeting']);
    expect(hinted.slugs).toContain('deals/acme-example');
    expect(hinted.notices.filter(n => n.code === 'search_filter_hint')).toHaveLength(1);
  });

  test('no hint once the caller filters by type, or for a plain query', async () => {
    expect(hint((await run('search', { query: `${TERM} meetings`, types: ['meeting'] }, true)).notices)).toBeUndefined();
    expect(hint((await run('search', { query: TERM }, true)).notices)).toBeUndefined();
  });

  test('a date word gets the since/until hint; search points at query', async () => {
    const q = (await run('query', { query: `${TERM} roadmap in 2024`, expand: false }, true)).notices;
    expect(hint(q)?.why).toContain('since/until');
    expect(hint(q)?.fix?.mcp).toEqual({ tool: 'query', arguments: { query: `${TERM} roadmap in 2024`, since: 'YYYY-MM-DD' } });
    expect(hint((await run('search', { query: `${TERM} roadmap last week` }, true)).notices)?.why).toContain('search has no date filter');
    expect(hint((await run('query', { query: `${TERM} roadmap in 2024`, since: '2024-01-01', expand: false }, true)).notices)).toBeUndefined();
  });

  test('top results filled by one unnamed type get the dominance hint', async () => {
    const rows = Array.from({ length: 10 }, () => ({ type: 'note' }));
    const n = await filterHint({ op: 'search', query: 'roadmap', rows, packTypes: ['note', 'person', 'deal'], hasPages: async () => true, filtered: { types: false, dates: false } });
    expect(n?.why).toContain('almost all "note" pages');
    expect(n?.why).toContain('person, deal');
    expect(await filterHint({ op: 'search', query: 'roadmap', rows: rows.slice(0, 5), packTypes: ['note', 'person'], hasPages: async () => true, filtered: { types: false, dates: false } })).toBeNull();
  });

  test('a named type with no pages the caller can see gets no hint', async () => {
    expect(await filterHint({ op: 'search', query: 'company roadmap', rows: [], packTypes: ['company'], hasPages: async () => false, filtered: { types: false, dates: false } })).toBeNull();
  });
});
