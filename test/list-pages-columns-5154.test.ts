/**
 * #5154 mitigation: list_pages reads only listing columns, so a listing never
 * detoasts or ships page bodies. Proven with column privileges: a role that
 * cannot read `compiled_truth`/`timeline` can still list, while a body-reading
 * projection is refused.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const listPages = operations.find(o => o.name === 'list_pages')!;

const ctx = (): OperationContext => ({
  engine: engine as any,
  config: {} as any,
  logger: { info() {}, warn() {}, error() {} },
  dryRun: false,
  remote: false,
  sourceId: 'default',
} as OperationContext);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const slug of ['notes/alpha-example', 'notes/beta-example']) {
    await engine.putPage(slug, { title: slug, type: 'note', compiled_truth: `${'body '.repeat(5000)}\n`, timeline: '- 2026-01-01: event' }, { sourceId: 'default' });
  }
  const columns = await engine.executeRaw<{ column_name: string }>(
    "SELECT column_name FROM information_schema.columns WHERE table_name = 'pages' AND column_name NOT IN ('compiled_truth', 'timeline')");
  await engine.executeRaw('CREATE ROLE list_columns_reader');
  await engine.executeRaw('GRANT SELECT ON ALL TABLES IN SCHEMA public TO list_columns_reader');
  await engine.executeRaw('REVOKE SELECT ON pages FROM list_columns_reader');
  await engine.executeRaw(`GRANT SELECT (${columns.map(c => `"${c.column_name}"`).join(', ')}) ON pages TO list_columns_reader`);
}, 60_000);

afterAll(async () => {
  await engine.executeRaw('RESET ROLE').catch(() => {});
  await engine.disconnect();
});

test('list_pages succeeds without read access to page bodies', async () => {
  await engine.executeRaw('SET ROLE list_columns_reader');
  try {
    await expect(engine.executeRaw('SELECT compiled_truth FROM pages LIMIT 1')).rejects.toThrow(/permission denied/);
    const rows = await listPages.handler(ctx(), { sort: 'slug', limit: 10 }) as Array<{ slug: string; type: string; title: string }>;
    expect(rows.map(r => r.slug)).toEqual(['notes/alpha-example', 'notes/beta-example']);
    expect(rows.every(r => r.type === 'note')).toBe(true);
  } finally {
    await engine.executeRaw('RESET ROLE');
  }
});

test('full listPages still returns bodies for callers that need them', async () => {
  const pages = await engine.listPages({ sort: 'slug', limit: 10 });
  expect(pages[0]!.compiled_truth).toContain('body body');
  expect(pages[0]!.timeline).toContain('2026-01-01');
  const listed = await engine.listPages({ sort: 'slug', limit: 10, listColumnsOnly: true });
  expect(listed.map(p => p.slug)).toEqual(pages.map(p => p.slug));
  expect(listed[0]!.compiled_truth).toBe('');
  expect(listed[0]!.frontmatter).toEqual({});
});
