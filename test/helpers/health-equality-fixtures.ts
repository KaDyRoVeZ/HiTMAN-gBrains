/**
 * Fixtures and the field-by-field comparison for the F4a get_health
 * migration: the single-statement `engine.getHealth` must equal the pre-F4a
 * implementation (`legacyGetHealth`) on every field, every scope shape and
 * both engines. Used by `test/engine-sql-health-equality.test.ts` (PGLite)
 * and `test/e2e/engine-sql-health-parity.test.ts` (Postgres, PgBouncer).
 */
import { expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { BrainHealth } from '../../src/core/types.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { parseMarkdown } from '../../src/core/markdown.ts';
import { resolveActiveEmbeddingColumnFromEngine, quoteIdentifier } from '../../src/core/search/embedding-column.ts';
import { legacyGetHealth } from './legacy-get-health.ts';

export const HEALTH_SRC_A = 'healthsrca';
export const HEALTH_SRC_B = 'healthsrcb';

/** Every scope shape the op layer can hand the engine, plus the fail-closed ones. */
export const HEALTH_SCOPES: Array<{ sourceId?: string; sourceIds?: string[] } | undefined> = [
  undefined,
  {},
  { sourceId: 'default' },
  { sourceId: HEALTH_SRC_A },
  { sourceIds: [HEALTH_SRC_A] },
  { sourceIds: [HEALTH_SRC_B] },
  { sourceIds: [HEALTH_SRC_A, HEALTH_SRC_B] },
  { sourceIds: [HEALTH_SRC_B, 'default', HEALTH_SRC_A] },
  { sourceIds: [] },
  { sourceId: '__all__' },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Slug shapes that hit every orphan-policy rule, its near misses and the override config. */
const SLUG_SHAPES: Array<(n: number) => string> = [
  (n) => `notes/note-${n}`,
  (n) => `people/person-${n}`,
  (n) => `companies/acme-example-${n}`,
  (n) => `concepts/idea-${n}`,
  (n) => `output/report-${n}`,
  (n) => `scratch/tmp-${n}`,
  (n) => `wiki/raw/import-${n}`,
  (n) => `journal/daily/day-${n}`,
  (n) => `daily-notes/day-${n}`,
  (n) => `life/events/2026-01-0${n % 9 + 1}-${n}`,
  (n) => `life/diary/entry-${n}`,
  (n) => `2026-02-${String(n % 28 + 1).padStart(2, '0')}`,
  (n) => `2026-02-${String(n % 28 + 1).padStart(2, '0')}-standup-${n}`,
  (n) => `2026-02-3x-${n}`,
  (n) => `agents/agent-${n}/soul`,
  (n) => `agents/agent-${n}/souls`,
  (n) => `agents/agent-${n}/memory/dreaming/d-${n}`,
  (n) => `agents/agent-${n}/notes/plan`,
  (n) => `_brain-${n}`,
  (n) => `topics/t-${n}/_index`,
  (n) => `topics/t-${n}/readme`,
  (n) => `topics/t-${n}/log`,
  (n) => `topics/t-${n}/logbook`,
  () => 'readme',
  (n) => `private-area/secret-${n}`,
  (n) => `one-off-${n % 3}`,
  (n) => `inbox/item-${n}`,
  (n) => `entities/e-${n}`,
];

const TYPES = ['person', 'company', 'entity', 'note', 'concept', 'meeting', 'atom', 'conversation', 'source', 'media'];

async function ensureSources(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('${HEALTH_SRC_A}', '${HEALTH_SRC_A}'), ('${HEALTH_SRC_B}', '${HEALTH_SRC_B}')
     ON CONFLICT (id) DO NOTHING`,
  );
}

async function pageIds(engine: BrainEngine): Promise<number[]> {
  return (await engine.executeRaw<{ id: number }>(`SELECT id FROM pages ORDER BY id`)).map(r => Number(r.id));
}

async function embedChunks(engine: BrainEngine, chunkIds: number[]): Promise<void> {
  if (chunkIds.length === 0) return;
  const column = (await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name;
  const [{ fmt }] = await engine.executeRaw<{ fmt: string }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS fmt FROM pg_attribute a
      WHERE a.attrelid = 'content_chunks'::regclass AND a.attname = $1`,
    [column],
  );
  const dims = Number(/\((\d+)\)/.exec(fmt)?.[1] ?? 0);
  await engine.executeRaw(
    `UPDATE content_chunks SET ${quoteIdentifier(column)} = (array_fill(0.01::float4, ARRAY[${dims}])::vector)::${fmt}
      WHERE id = ANY($1::int[])`,
    [chunkIds],
  );
}

/**
 * A seeded random graph over three sources: every orphan-policy slug shape,
 * every page type, quarantined and embed_skip pages, soft-deleted pages,
 * self-links and cross-source links, timeline rows, embedded and unembedded
 * chunks, and per-brain orphan overrides.
 */
export async function seedRandomHealthGraph(engine: BrainEngine, seed: number, pagesPerSource = 60): Promise<void> {
  const rand = mulberry32(seed);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  await ensureSources(engine);
  let n = 0;
  for (const sourceId of ['default', HEALTH_SRC_A, HEALTH_SRC_B]) {
    for (let i = 0; i < pagesPerSource; i++) {
      n++;
      const slug = pick(SLUG_SHAPES)(n);
      const frontmatter: Record<string, unknown> = {};
      if (rand() < 0.08) frontmatter.quarantine = { reason: 'junk_pattern', detail: 'fixture' };
      if (rand() < 0.1) frontmatter.embed_skip = true;
      await engine.putPage(slug, { type: pick(TYPES) as never, title: `Page ${n}`, compiled_truth: `Body ${n}.`, frontmatter }, { sourceId });
    }
  }
  const ids = await pageIds(engine);
  const links: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const from = pick(ids);
    const to = rand() < 0.05 ? from : pick(ids);
    links.push(`(${from}, ${to}, 'fixture-${i % 4}')`);
  }
  // Hubs with distinct degrees, so the top of most_connected has no ties.
  const people = (await engine.executeRaw<{ id: number }>(
    `SELECT id FROM pages WHERE type IN ('person', 'company', 'entity') AND deleted_at IS NULL ORDER BY id LIMIT 3`,
  )).map(r => Number(r.id));
  people.forEach((hub, rank) => {
    for (let k = 0; k < 40 - rank * 10; k++) links.push(`(${pick(ids)}, ${hub}, 'hub-${k}')`);
  });
  await engine.executeRaw(
    `INSERT INTO links (from_page_id, to_page_id, link_type) VALUES ${links.join(', ')} ON CONFLICT DO NOTHING`,
  );
  const timeline: string[] = [];
  for (const id of ids) if (rand() < 0.3) timeline.push(`(${id}, '2026-03-0${Math.floor(rand() * 9) + 1}', 'event ${id}')`);
  if (timeline.length) await engine.executeRaw(`INSERT INTO timeline_entries (page_id, date, summary) VALUES ${timeline.join(', ')} ON CONFLICT DO NOTHING`);
  const chunks: string[] = [];
  for (const id of ids) {
    const count = Math.floor(rand() * 3);
    for (let c = 0; c < count; c++) chunks.push(`(${id}, ${c}, 'chunk ${id}-${c}')`);
  }
  if (chunks.length) {
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text) VALUES ${chunks.join(', ')} ON CONFLICT DO NOTHING`);
    const chunkIds = (await engine.executeRaw<{ id: number }>(`SELECT id FROM content_chunks ORDER BY id`)).map(r => Number(r.id));
    await embedChunks(engine, chunkIds.filter(() => rand() < 0.6));
  }
  const doomed = ids.filter(() => rand() < 0.1);
  await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE id = ANY($1::int[])`, [doomed]);
  await engine.setConfig('orphans.exclude_prefixes', 'private-area/, agents/agent-1');
  await engine.setConfig('orphans.exclude_slugs', 'one-off-1, one-off-2');
}

/** The #4592 source-scope fixture (test/stats-health-source-scope.test.ts) on this file's sources. */
export async function seedSourceScopeFixture(engine: BrainEngine): Promise<void> {
  await ensureSources(engine);
  const put = (sourceId: string, slug: string, type: string) =>
    engine.putPage(slug, { title: slug, type: type as never, compiled_truth: `# ${slug}\n` }, { sourceId });
  await put(HEALTH_SRC_A, 'people/alice-example', 'person');
  await put(HEALTH_SRC_A, 'notes/alpha', 'note');
  await put(HEALTH_SRC_B, 'people/bob-example', 'person');
  const id = async (slug: string) => Number((await engine.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = $1`, [slug]))[0].id);
  const [alice, alpha, bob] = [await id('people/alice-example'), await id('notes/alpha'), await id('people/bob-example')];
  await engine.executeRaw(
    `INSERT INTO links (from_page_id, to_page_id, link_type) VALUES (${alpha}, ${alice}, 'wikilink'), (${alice}, ${bob}, 'wikilink'), (${bob}, ${alpha}, 'wikilink')`,
  );
  await engine.executeRaw(`INSERT INTO timeline_entries (page_id, date, summary) VALUES (${alice}, '2026-08-01', 'a'), (${bob}, '2026-08-02', 'b')`);
  await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text) VALUES (${alice}, 0, 'a'), (${alpha}, 0, 'b'), (${bob}, 0, 'c')`);
}

/** The markdown corpus under test/e2e/fixtures, imported the way the E2E suite imports it. */
export async function importE2eMarkdownFixtures(engine: BrainEngine): Promise<number> {
  const root = resolve(import.meta.dir, '../e2e/fixtures');
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (extname(entry) === '.md') files.push(full);
    }
  };
  walk(root);
  for (const file of files) {
    const content = readFileSync(file, 'utf-8');
    const parsed = parseMarkdown(content, relative(root, file));
    await importFromContent(engine, parsed.slug, content, { noEmbed: true });
  }
  return files.length;
}

/**
 * The old `most_connected` ordered by count only, so equal counts came back in
 * an unspecified order. Counts must match position by position; slugs must
 * match exactly above the lowest count in the list, and as a subset of the
 * old list's tie group at the cut (both pick from the same tie group).
 */
function expectSameMostConnected(actual: BrainHealth['most_connected'], expected: BrainHealth['most_connected'], label: string): void {
  expect(actual.map(m => m.link_count), `${label}: most_connected counts`).toEqual(expected.map(m => m.link_count));
  if (expected.length === 0) return;
  const cut = expected[expected.length - 1].link_count;
  const above = (xs: BrainHealth['most_connected']) => xs.filter(m => m.link_count > cut).map(m => m.slug).sort();
  expect(above(actual), `${label}: most_connected slugs above the cut`).toEqual(above(expected));
  const sorted = [...actual].sort((a, b) => b.link_count - a.link_count || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  expect(actual, `${label}: ties break by slug (code point order)`).toEqual(sorted);
}

/** Field-by-field equality of the migrated getHealth against the pre-F4a implementation. */
export async function expectHealthMatchesLegacy(engine: BrainEngine, label: string): Promise<BrainHealth[]> {
  const results: BrainHealth[] = [];
  for (const scope of HEALTH_SCOPES) {
    const tag = `${label} scope=${JSON.stringify(scope)}`;
    const expected = await legacyGetHealth(engine, scope);
    const actual = await engine.getHealth(scope);
    expect(Object.keys(actual).sort(), `${tag}: field set`).toEqual(Object.keys(expected).sort());
    for (const key of Object.keys(expected) as Array<keyof BrainHealth>) {
      if (key === 'most_connected') continue;
      expect(actual[key], `${tag}: ${key}`).toEqual(expected[key]);
    }
    expectSameMostConnected(actual.most_connected, expected.most_connected, tag);
    results.push(actual);
  }
  return results;
}
