/**
 * #7159 engine parity: the frontmatter `where` filter returns the same pages
 * on PGLite and Postgres for search, query and list_pages, and a remote
 * caller never reaches a private page through it (Postgres arm runs when
 * DATABASE_URL is set; the PGLite arm always runs).
 *
 * Postgres reads jsonb containment through postgres.js parameters and the
 * GIN index on pages.frontmatter; a cast or parameter-type slip there would
 * drop or widen matches only on Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { searchCtx } from '../helpers/keyword-paging-fixture.ts';
import { PRIVATE_WHERE, PRIVATE_WHERE_LOCAL, PRIVATE_WHERE_REMOTE, TERM, WHERE_CASES, seedFrontmatterCorpus } from '../helpers/frontmatter-where-fixture.ts';

const backends = process.env.DATABASE_URL ? ['pglite', 'postgres'] as const : ['pglite'] as const;
const engines: Partial<Record<(typeof backends)[number], BrainEngine>> = {};
const closers: Array<() => Promise<void>> = [];

async function slugs(engine: BrainEngine, name: string, params: Record<string, unknown>, remote = true): Promise<string[]> {
  const rows = await operations.find(o => o.name === name)!.handler(searchCtx(engine, remote) as never, params) as Array<{ slug: string }>;
  return [...new Set(rows.map(r => r.slug))].sort();
}

beforeAll(async () => {
  for (const backend of backends) {
    let engine: BrainEngine;
    if (backend === 'postgres') {
      const isolated = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engine = isolated.engine;
      closers.push(isolated.close);
    } else {
      engine = new PGLiteEngine();
      await engine.connect({});
      await engine.initSchema();
      closers.push(() => engine.disconnect());
    }
    await seedFrontmatterCorpus(engine);
    engines[backend] = engine;
  }
}, 300_000);

afterAll(async () => { for (const close of closers) await close(); });

for (const backend of backends) {
  describe(`where filter on ${backend}`, () => {
    for (const [label, where, expected] of WHERE_CASES) {
      test(label, async () => {
        const engine = engines[backend]!;
        expect(await slugs(engine, 'search', { query: TERM, where })).toEqual(expected);
        expect(await slugs(engine, 'search', { query: TERM, where, match: 'keyword' })).toEqual(expected);
        expect(await slugs(engine, 'query', { query: TERM, where, expand: false })).toEqual(expected);
        expect(await slugs(engine, 'list_pages', { where })).toEqual(expected);
      });
    }

    test('remote callers stay private-filtered; the local CLI does not', async () => {
      const engine = engines[backend]!;
      for (const name of ['search', 'list_pages']) {
        expect(await slugs(engine, name, { query: TERM, where: PRIVATE_WHERE })).toEqual(PRIVATE_WHERE_REMOTE);
        expect(await slugs(engine, name, { query: TERM, where: PRIVATE_WHERE }, false)).toEqual(PRIVATE_WHERE_LOCAL);
      }
    });
  });
}
