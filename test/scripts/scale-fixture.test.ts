/**
 * The scale harness (`bun run test:scale`) is reproducible only if its fixture
 * is: the same seed and page count must give byte-identical pages, and the
 * known answers the harness asserts (search tokens, islands, the hub, facts and
 * takes counts, the vector probe, the grant probe, the two writers) must hold
 * in the fixture itself.
 */
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateScaleFixture, SCALE_VECTOR_DIMS, scaleVector, writeScaleCorpus } from '../../scripts/scale/fixture.ts';
import { parseFactsFence } from '../../src/core/facts-fence.ts';
import { parseTakesFence } from '../../src/core/takes-fence.ts';

test('same seed and size give an identical fixture; another seed differs', () => {
  const a = generateScaleFixture({ pages: 300, seed: 7 });
  const b = generateScaleFixture({ pages: 300, seed: 7 });
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  expect(JSON.stringify(generateScaleFixture({ pages: 300, seed: 8 }).pages)).not.toBe(JSON.stringify(a.pages));
});

test('fixture shape: page count, two sources, unique tokens, links stay in their source, islands and hub hold', () => {
  const f = generateScaleFixture({ pages: 301, seed: 1 });
  expect(f.pages.length).toBe(301);
  expect(f.pages.filter(p => p.sourceId === 'default').length).toBe(151);
  expect(new Set(f.pages.map(p => p.token)).size).toBe(301);
  for (const p of f.pages) {
    expect(p.content).toContain(p.token);
    const own = new Set(f.pages.filter(q => q.sourceId === p.sourceId).map(q => q.slug));
    for (const target of p.links) expect(own.has(target)).toBe(true);
  }
  expect(f.islands.length).toBeGreaterThan(0);
  for (const island of f.islands) {
    expect(f.pages.some(p => p.sourceId === 'default' && p.links.includes(island))).toBe(false);
  }
  expect(f.pages.find(p => p.slug === f.hub && p.sourceId === 'default')!.links.length).toBe(3);
  expect(() => generateScaleFixture({ pages: 5, seed: 1 })).toThrow();
});

test('fixture additions: facts/takes fences parse, vectors single out their page, grant and writer probes hold', () => {
  const f = generateScaleFixture({ pages: 400, seed: 3 });
  let facts = 0;
  let takes = 0;
  for (const p of f.pages) {
    const parsedFacts = parseFactsFence(p.content);
    const parsedTakes = parseTakesFence(p.content);
    expect(parsedFacts.warnings).toEqual([]);
    expect(parsedTakes.warnings).toEqual([]);
    expect(parsedFacts.facts.length).toBe(p.facts);
    expect(parsedTakes.takes.length).toBe(p.takes);
    facts += parsedFacts.facts.length;
    takes += parsedTakes.takes.length;
  }
  expect(facts).toBeGreaterThan(0);
  expect(f.expected).toEqual({ facts, takes });

  // Dense unit vectors in a low-dimensional subspace: the probe page is the only page at cosine 1 to its own vector.
  const dim = 64;
  const probe = scaleVector(f.vectorProbe.index, dim);
  expect(probe.slice(SCALE_VECTOR_DIMS).every(x => x === 0)).toBe(true);
  expect(Math.abs(probe.reduce((s, x) => s + x * x, 0) - 1)).toBeLessThan(1e-5);
  const cosines = f.pages.map(p => scaleVector(p.index, dim).reduce((s, x, i) => s + x * probe[i]!, 0));
  expect(cosines.filter(c => c > 0.999)).toHaveLength(1);
  expect(f.pages[f.vectorProbe.index]).toMatchObject({ sourceId: f.vectorProbe.sourceId, slug: f.vectorProbe.slug });
  expect(f.pages.some(p => p.content.includes(f.vectorProbe.query))).toBe(false);

  expect(f.grant.visible.sourceId).toBe(f.grant.allowed);
  expect(f.grant.hidden.sourceId).not.toBe(f.grant.allowed);
  expect(f.pages.filter(p => new RegExp(`\\b${f.grant.hidden.token}\\b`).test(p.content)).map(p => p.sourceId)).toEqual([f.grant.hidden.sourceId]);

  const [a, b] = f.writers;
  expect(a.requestId).not.toBe(b.requestId);
  expect(a.slug).not.toBe(b.slug);
  for (const w of f.writers) expect(w.requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('writeScaleCorpus never trusts the manifest alone: missing, edited or extra files regenerate the corpus', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scale-corpus-'));
  try {
    const f = generateScaleFixture({ pages: 40, seed: 3 });
    const [first, second] = [f.pages[0]!, f.pages[1]!];
    const file = (p: typeof first) => join(dir, p.sourceId, `${p.slug}.md`);
    expect(writeScaleCorpus(f, dir)).toBe(true);
    // A cache restored from a partial run: the manifest is there, the files are not.
    for (const sourceId of new Set(f.pages.map(p => p.sourceId))) rmSync(join(dir, sourceId), { recursive: true, force: true });
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
    expect(writeScaleCorpus(f, dir)).toBe(true);
    for (const p of f.pages) expect(readFileSync(file(p), 'utf8')).toBe(p.content);
    rmSync(file(first));
    expect(writeScaleCorpus(f, dir)).toBe(true);
    expect(readFileSync(file(first), 'utf8')).toBe(first.content);
    writeFileSync(file(second), 'edited by hand\n');
    expect(writeScaleCorpus(f, dir)).toBe(true);
    expect(readFileSync(file(second), 'utf8')).toBe(second.content);
    writeFileSync(join(dir, first.sourceId, 'stray.md'), 'not a fixture page\n');
    expect(writeScaleCorpus(f, dir)).toBe(true);
    expect(existsSync(join(dir, first.sourceId, 'stray.md'))).toBe(false);
    expect(writeScaleCorpus(f, dir)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeScaleCorpus writes one Markdown file per page once, reuses a matching corpus and rewrites a stale one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'scale-corpus-'));
  try {
    const f = generateScaleFixture({ pages: 40, seed: 2 });
    expect(writeScaleCorpus(f, dir)).toBe(true);
    for (const p of f.pages) expect(readFileSync(join(dir, p.sourceId, `${p.slug}.md`), 'utf8')).toBe(p.content);
    expect(writeScaleCorpus(f, dir)).toBe(false);
    const other = generateScaleFixture({ pages: 40, seed: 9 });
    expect(writeScaleCorpus(other, dir)).toBe(true);
    for (const p of other.pages) expect(readFileSync(join(dir, p.sourceId, `${p.slug}.md`), 'utf8')).toBe(p.content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
