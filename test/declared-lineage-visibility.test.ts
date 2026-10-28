/**
 * Declared lineage: a page whose `derived_from` frontmatter names a private
 * page is private to remote readers too. Found by gbrain-evals Cat 40, where an
 * unlabeled digest repeated a finance-only discount and remote agents reported
 * it after the labeled memo itself was hidden.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { operationsByName } from '../src/core/operations.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

const pages = [
  ['finance/discount-memo', 'note', 'wombat finance only discount memo', { visibility: 'private' }],
  ['notes/world-note', 'note', 'wombat ordinary world note', {}],
  ['digests/from-private', 'note', 'wombat digest repeating the discount', { derived_from: ['finance/discount-memo', 'notes/world-note'] }],
  ['digests/from-private-md', 'note', 'wombat digest naming the memo file', { derived_from: 'finance/discount-memo.md' }],
  ['digests/from-world', 'note', 'wombat digest of world material', { derived_from: ['notes/world-note'] }],
  ['digests/from-missing', 'note', 'wombat digest of a page that does not exist', { derived_from: ['notes/never-written'] }],
] as const;
const hidden = ['finance/discount-memo', 'digests/from-private', 'digests/from-private-md'];
const visible = ['notes/world-note', 'digests/from-world', 'digests/from-missing'];

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) {
    for (const [slug, type, body, frontmatter] of pages) {
      const result = await importFromContent(engine, slug, serializeMarkdown(frontmatter, body, '', { type, title: slug, tags: [] }),
        { noEmbed: true, forceRechunk: true });
      expect(result.status).toBe('imported');
    }
  }
}, 120_000);

afterAll(async () => {
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

const ctx = (engine: BrainEngine, remote: boolean) => ({ engine, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} },
  dryRun: false, remote, sourceId: 'default' }) as never;

describe('derived_from carries private visibility to derived pages', () => {
  test('remote list_pages hides pages derived from a private page; local lists everything', async () => {
    for (const engine of engines) {
      __resetPrivateVisibilityCacheForTests();
      const remote = ((await operationsByName.list_pages.handler(ctx(engine, true), { limit: 100 })) as Array<{ slug: string }>).map(r => r.slug);
      for (const slug of hidden) expect(remote).not.toContain(slug);
      for (const slug of visible) expect(remote).toContain(slug);
      const local = ((await operationsByName.list_pages.handler(ctx(engine, false), { limit: 100 })) as Array<{ slug: string }>).map(r => r.slug);
      for (const slug of [...hidden, ...visible]) expect(local).toContain(slug);
    }
  });

  test('remote get_page refuses a page derived from a private page', async () => {
    for (const engine of engines) {
      __resetPrivateVisibilityCacheForTests();
      for (const slug of ['digests/from-private', 'digests/from-private-md']) {
        await expect(operationsByName.get_page.handler(ctx(engine, true), { slug })).rejects.toThrow('Page not found');
        const local = await operationsByName.get_page.handler(ctx(engine, false), { slug }) as { slug: string };
        expect(local.slug).toBe(slug);
      }
      const world = await operationsByName.get_page.handler(ctx(engine, true), { slug: 'digests/from-world' }) as { slug: string };
      expect(world.slug).toBe('digests/from-world');
    }
  });

  test('remote keyword search does not return derived-private text', async () => {
    for (const engine of engines) {
      __resetPrivateVisibilityCacheForTests();
      const rows = await engine.searchKeyword('wombat', { limit: 50, excludePrivate: true });
      const slugs = rows.map(r => r.slug);
      for (const slug of hidden) expect(slugs).not.toContain(slug);
      expect(slugs).toContain('digests/from-world');
    }
  });
});
