/**
 * #7191 ask 2: search_exact on real Postgres. The unit suite
 * (test/search-exact.test.ts) pins matching, completeness and the remote
 * visibility contract on PGLite; this proves the same statement on pgvector
 * Postgres, under its statement timeout, for local and remote callers.
 *
 * Gated by DATABASE_URL — skips gracefully without real Postgres.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { runExactScan } from '../../src/core/search/exact-scan.ts';

const SKIP = !hasDatabase();
const describePg = SKIP ? describe.skip : describe;

function mkCtx(engine: unknown, overrides: Record<string, unknown> = {}) {
  return { engine, config: {} as never, logger: { info: () => {}, warn: () => {}, error: () => {} } as never,
    dryRun: false, remote: false, sourceId: 'default', ...overrides } as never;
}

describePg('search_exact on real Postgres (#7191)', () => {
  beforeAll(async () => {
    await setupDB();
    const engine = getEngine();
    const page = (slug: string, body: string, fm = '') =>
      importFromContent(engine as never, slug, '---\ntitle: ' + slug + '\ntype: note\n' + fm + '---\n' + body, { sourceId: 'default', noEmbed: true });
    for (let i = 0; i < 12; i++) await page('notes/filler-' + i, 'ordinary text number ' + i);
    await page('notes/world', 'The Quarterly\nBoard  Pack is due (v2.1).');
    await page('notes/private', 'board pack private copy', 'visibility: private\n');
    await page('notes/old', 'board pack legacy copy');
    await engine.executeRaw("UPDATE pages SET chunker_version = 1 WHERE slug = 'notes/old'");
  }, 240_000);

  afterAll(async () => {
    await teardownDB();
  });

  const exact = (ctx: unknown, params: Record<string, unknown>) => operationsByName['search_exact']!.handler(ctx as never, params) as Promise<any>;

  test('a local caller matches every page holding the phrase and the scan is complete', async () => {
    const res = await exact(mkCtx(getEngine()), { phrase: 'board pack' });
    expect(res.matches.map((m: any) => m.slug).sort()).toEqual(['notes/old', 'notes/private', 'notes/world']);
    expect(res.complete).toBe(true);
    expect(res.matches.find((m: any) => m.slug === 'notes/world').snippets[0].text).toContain('Board  Pack');
    expect((await exact(mkCtx(getEngine()), { phrase: '(v2.1)' })).matches.map((m: any) => m.slug)).toEqual(['notes/world']);
  });

  test('a remote caller sees neither the private nor the unsealed page and is told the unsealed one was not read', async () => {
    const res = await exact(mkCtx(getEngine(), { remote: true, transport: 'stdio', auth: { allowedSources: ['default'] } }), { phrase: 'board pack' });
    expect(res.matches.map((m: any) => m.slug)).toEqual(['notes/world']);
    expect(res).toMatchObject({ complete: false, incomplete_reasons: ['unreadable_pages'], unreadable: { by_reason: { unsealed: 1 } } });
    expect(JSON.stringify(res)).not.toContain('private copy');
  });

  test('small batches give the same answer under the Postgres statement timeout', async () => {
    const base = { phrase: 'board pack', excludeSlugPrefixes: [], excludePrivate: false, remote: false, limit: 100, deadlineMs: Date.now() + 60_000, sourceId: 'default' };
    const whole = await runExactScan(getEngine(), base);
    const batched = await runExactScan(getEngine(), { ...base, batchPages: 4 });
    expect(batched.matches.map(m => m.slug)).toEqual(whole.matches.map(m => m.slug));
    expect(batched.pages_scanned).toBe(whole.pages_scanned);
    expect(batched.complete).toBe(true);
  });
});
