/**
 * v0.20.0 Cathedral II Layer 7 (A2) — two-pass retrieval tests.
 *
 * Validates:
 *   - expandAnchors no-op when walkDepth=0 and nearSymbol unset.
 *   - walkDepth=1 adds 1-hop neighbors with decayed scores.
 *   - walkDepth=2 adds 2-hop neighbors (capped).
 *   - nearSymbol anchors chunks by qualified name.
 *   - hybridSearch respects opts.walkDepth + opts.nearSymbol without
 *     breaking the default-off retrieval path.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { expandAnchors, hydrateChunks } from '../src/core/search/two-pass.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import { importCodeFile, importFromContent } from '../src/core/import-file.ts';
import { resolveSymbolEdgesIncremental } from '../src/core/chunkers/symbol-resolver.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';

describe('Layer 7 (A2) — expandAnchors', () => {
  let engine: PGLiteEngine;
  let chunkA: number;
  let chunkB: number;
  let chunkC: number;

  beforeAll(async () => {
    configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    await engine.putPage('src-a-ts', {
      type: 'code', page_kind: 'code',
      title: 'src/a.ts (typescript)',
      compiled_truth: 'export function a() { return b(); }',
      timeline: '',
    });
    await installFixtureChunks(engine, 'src-a-ts', [{
      chunk_index: 0,
      chunk_text: 'export function a() { return b(); }',
      chunk_source: 'compiled_truth',
      language: 'typescript',
      symbol_name: 'a', symbol_type: 'function',
      symbol_name_qualified: 'a',
    }]);

    await engine.putPage('src-b-ts', {
      type: 'code', page_kind: 'code',
      title: 'src/b.ts (typescript)',
      compiled_truth: 'export function b() { return c(); }',
      timeline: '',
    });
    await installFixtureChunks(engine, 'src-b-ts', [{
      chunk_index: 0,
      chunk_text: 'export function b() { return c(); }',
      chunk_source: 'compiled_truth',
      language: 'typescript',
      symbol_name: 'b', symbol_type: 'function',
      symbol_name_qualified: 'b',
    }]);

    await engine.putPage('src-c-ts', {
      type: 'code', page_kind: 'code',
      title: 'src/c.ts (typescript)',
      compiled_truth: 'export function c() { return 1; }',
      timeline: '',
    });
    await installFixtureChunks(engine, 'src-c-ts', [{
      chunk_index: 0,
      chunk_text: 'export function c() { return 1; }',
      chunk_source: 'compiled_truth',
      language: 'typescript',
      symbol_name: 'c', symbol_type: 'function',
      symbol_name_qualified: 'c',
    }]);

    const aChunks = await engine.getChunks('src-a-ts');
    const bChunks = await engine.getChunks('src-b-ts');
    const cChunks = await engine.getChunks('src-c-ts');
    chunkA = aChunks[0]!.id;
    chunkB = bChunks[0]!.id;
    chunkC = cChunks[0]!.id;

    // Edges: a → b, b → c (unresolved — code_edges_symbol path).
    await engine.addCodeEdges([
      { from_chunk_id: chunkA, to_chunk_id: null,
        from_symbol_qualified: 'a', to_symbol_qualified: 'b',
        edge_type: 'calls' },
      { from_chunk_id: chunkB, to_chunk_id: null,
        from_symbol_qualified: 'b', to_symbol_qualified: 'c',
        edge_type: 'calls' },
    ]);
  });

  afterAll(async () => {
    resetGateway();
    await engine.disconnect();
  }, 30_000);

  test('walkDepth=0 is a no-op (anchors only)', async () => {
    const anchors = [{
      slug: 'src-a-ts', page_id: 0, title: 'a', type: 'code',
      chunk_text: '', chunk_source: 'compiled_truth', chunk_id: chunkA,
      chunk_index: 0, score: 1.0, stale: false, source_id: 'default',
    } as never];
    const expanded = await expandAnchors(engine, anchors, { walkDepth: 0 });
    expect(expanded.length).toBe(1);
    expect(expanded[0]!.chunk_id).toBe(chunkA);
    expect(expanded[0]!.hop).toBe(0);
  });

  test('walkDepth=1 expands to direct neighbors', async () => {
    const anchors = [{
      slug: 'src-a-ts', page_id: 0, title: 'a', type: 'code',
      chunk_text: '', chunk_source: 'compiled_truth', chunk_id: chunkA,
      chunk_index: 0, score: 1.0, stale: false, source_id: 'default',
    } as never];
    const expanded = await expandAnchors(engine, anchors, { walkDepth: 1 });
    const ids = expanded.map(e => e.chunk_id);
    expect(ids).toContain(chunkA); // anchor
    expect(ids).toContain(chunkB); // 1-hop neighbor via calls edge

    const neighbor = expanded.find(e => e.chunk_id === chunkB);
    expect(neighbor!.hop).toBe(1);
    // 1/(1+1) * 1.0 = 0.5
    expect(neighbor!.score).toBeCloseTo(0.5, 2);
  });

  test('walkDepth=2 reaches grandchildren', async () => {
    const anchors = [{
      slug: 'src-a-ts', page_id: 0, title: 'a', type: 'code',
      chunk_text: '', chunk_source: 'compiled_truth', chunk_id: chunkA,
      chunk_index: 0, score: 1.0, stale: false, source_id: 'default',
    } as never];
    const expanded = await expandAnchors(engine, anchors, { walkDepth: 2 });
    const ids = expanded.map(e => e.chunk_id);
    expect(ids).toContain(chunkC); // 2-hop
    const twoHop = expanded.find(e => e.chunk_id === chunkC);
    expect(twoHop!.hop).toBe(2);
  });

  test('walkDepth clamps at 2 (even when caller passes 5)', async () => {
    const anchors = [{
      slug: 'src-a-ts', page_id: 0, title: 'a', type: 'code',
      chunk_text: '', chunk_source: 'compiled_truth', chunk_id: chunkA,
      chunk_index: 0, score: 1.0, stale: false, source_id: 'default',
    } as never];
    const expanded = await expandAnchors(engine, anchors, { walkDepth: 5 });
    const maxHop = Math.max(...expanded.map(e => e.hop));
    expect(maxHop).toBeLessThanOrEqual(2);
  });

  test('nearSymbol anchors chunks by qualified name', async () => {
    const expanded = await expandAnchors(engine, [], {
      walkDepth: 1,
      nearSymbol: 'b',
    });
    const ids = expanded.map(e => e.chunk_id);
    expect(ids).toContain(chunkB); // anchored via nearSymbol
    expect(ids).toContain(chunkC); // 1-hop neighbor
  });

  test('hydrateChunks fetches SearchResult rows for chunk IDs', async () => {
    const rows = await hydrateChunks(engine, [chunkB, chunkC]);
    expect(rows.length).toBe(2);
    const slugs = rows.map(r => r.slug);
    expect(slugs).toContain('src-b-ts');
    expect(slugs).toContain('src-c-ts');
  });

  test('hydrateChunks with empty array returns []', async () => {
    const rows = await hydrateChunks(engine, []);
    expect(rows).toEqual([]);
  });

  test('untrusted hybrid retrieval suspends structural expansion that could inject unsealed chunks', async () => {
    const slug = 'notes/structural-public-anchor';
    await importFromContent(engine, slug, '---\ntitle: publicanchor\ntype: note\n---\npublicanchor content', { noEmbed: true, forceRechunk: true });
    const page = (await engine.getPage(slug))!;
    const vector = new Float32Array(1536); vector[0] = 1;
    await engine.executeRaw('UPDATE content_chunks SET embedding = $1::vector WHERE page_id = $2', [`[${Array.from(vector)}]`, page.id]);
    await engine.executeRaw('UPDATE content_chunks SET chunk_text = $1 WHERE id = $2', ['PRIVATE_TWO_PASS_CANARY', chunkB]);
    const opts = { sourceId: 'default', expansion: false, queryEmbedFn: () => vector, nearSymbol: 'b', walkDepth: 1, limit: 20, excludePrivate: false };
    const local = await hybridSearch(engine, 'publicanchor', { ...opts, requireSafeChunks: false });
    expect(JSON.stringify(local)).toContain('PRIVATE_TWO_PASS_CANARY');
    const remote = await hybridSearch(engine, 'publicanchor', { ...opts, requireSafeChunks: true });
    expect(remote.map(row => row.slug)).toContain(slug);
    expect(JSON.stringify(remote)).not.toContain('PRIVATE_TWO_PASS_CANARY');
    expect(remote.map(row => row.slug)).not.toContain('src-b-ts');
  });
});

describe('Layer 7 (A2) — resolver outcome consumption', () => {
  let engine: PGLiteEngine;
  let chunkX: number;
  let chunkBmain: number;
  let chunkBalias: number;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // Caller page.
    await engine.putPage('src-x-ts', {
      type: 'code', page_kind: 'code',
      title: 'src/x.ts (typescript)',
      compiled_truth: 'export function x() { return b(); }',
      timeline: '',
    });
    await installFixtureChunks(engine, 'src-x-ts', [{
      chunk_index: 0,
      chunk_text: 'export function x() { return b(); }',
      chunk_source: 'compiled_truth',
      language: 'typescript',
      symbol_name: 'x', symbol_type: 'function',
      symbol_name_qualified: 'x',
    }]);

    // The qualified name 'b' is defined in TWO files — the aliasing case the
    // resolver exists to disambiguate.
    for (const slug of ['src-bmain-ts', 'src-balias-ts']) {
      await engine.putPage(slug, {
        type: 'code', page_kind: 'code',
        title: `${slug} (typescript)`,
        compiled_truth: 'export function b() { return 1; }',
        timeline: '',
      });
      await installFixtureChunks(engine, slug, [{
        chunk_index: 0,
        chunk_text: 'export function b() { return 1; }',
        chunk_source: 'compiled_truth',
        language: 'typescript',
        symbol_name: 'b', symbol_type: 'function',
        symbol_name_qualified: 'b',
      }]);
    }

    chunkX = (await engine.getChunks('src-x-ts'))[0]!.id;
    chunkBmain = (await engine.getChunks('src-bmain-ts'))[0]!.id;
    chunkBalias = (await engine.getChunks('src-balias-ts'))[0]!.id;
  });

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  const anchor = (chunkId: number) => [{
    slug: 'src-x-ts', page_id: 0, title: 'x', type: 'code',
    chunk_text: '', chunk_source: 'compiled_truth', chunk_id: chunkId,
    chunk_index: 0, score: 1.0, stale: false, source_id: 'default',
  } as never];

  test('resolved_chunk_id in edge_metadata wins over the name lookup', async () => {
    await engine.addCodeEdges([{
      from_chunk_id: chunkX, to_chunk_id: null,
      from_symbol_qualified: 'x', to_symbol_qualified: 'b',
      edge_type: 'calls',
      edge_metadata: { resolved_chunk_id: chunkBmain },
    }]);
    const expanded = await expandAnchors(engine, anchor(chunkX), { walkDepth: 1 });
    const ids = expanded.map(e => e.chunk_id);
    expect(ids).toContain(chunkBmain);
    // The pre-fix behavior re-looked-up 'b' by name across ALL files and
    // pulled in the alias file too — exactly what the resolver prevents.
    expect(ids).not.toContain(chunkBalias);
  });

  test('ambiguous candidates are followed directly', async () => {
    // A fresh caller whose only edge is ambiguous: no chunk is named
    // 'ambig_target', so only the candidate list can reach chunkBalias.
    await engine.putPage('src-z-ts', {
      type: 'code', page_kind: 'code',
      title: 'src/z.ts (typescript)',
      compiled_truth: 'export function z() { return ambig_target(); }',
      timeline: '',
    });
    await installFixtureChunks(engine, 'src-z-ts', [{
      chunk_index: 0,
      chunk_text: 'export function z() { return ambig_target(); }',
      chunk_source: 'compiled_truth',
      language: 'typescript',
      symbol_name: 'z', symbol_type: 'function',
      symbol_name_qualified: 'z',
    }]);
    const chunkZ = (await engine.getChunks('src-z-ts'))[0]!.id;
    await engine.addCodeEdges([{
      from_chunk_id: chunkZ, to_chunk_id: null,
      from_symbol_qualified: 'z', to_symbol_qualified: 'ambig_target',
      edge_type: 'calls',
      edge_metadata: { ambiguous: true, candidates: [chunkBalias] },
    }]);
    const expanded = await expandAnchors(engine, anchor(chunkZ), { walkDepth: 1 });
    const ids = expanded.map(e => e.chunk_id);
    expect(ids).toContain(chunkBalias);
    expect(ids).not.toContain(chunkBmain);
  });

  test('unresolved edges (no resolver outcome) still match by qualified name', async () => {
    // A second caller chunk y → 'b' with NO edge_metadata: the name lookup
    // fans out to every definition, both files.
    await engine.putPage('src-y-ts', {
      type: 'code', page_kind: 'code',
      title: 'src/y.ts (typescript)',
      compiled_truth: 'export function y() { return b(); }',
      timeline: '',
    });
    await installFixtureChunks(engine, 'src-y-ts', [{
      chunk_index: 0,
      chunk_text: 'export function y() { return b(); }',
      chunk_source: 'compiled_truth',
      language: 'typescript',
      symbol_name: 'y', symbol_type: 'function',
      symbol_name_qualified: 'y',
    }]);
    const chunkY = (await engine.getChunks('src-y-ts'))[0]!.id;
    await engine.addCodeEdges([{
      from_chunk_id: chunkY, to_chunk_id: null,
      from_symbol_qualified: 'y', to_symbol_qualified: 'b',
      edge_type: 'calls',
    }]);
    const expanded = await expandAnchors(engine, anchor(chunkY), { walkDepth: 1 });
    const ids = expanded.map(e => e.chunk_id);
    expect(ids).toContain(chunkBmain);
    expect(ids).toContain(chunkBalias);
  });

  test('a real resolver pass keeps the walk inside the caller file', async () => {
    await importCodeFile(engine, 'src/local.ts',
      'export function helperz(): number {\n  return 1;\n}\n\nexport function callerz(): number {\n  return helperz() + 1;\n}\n',
      { noEmbed: true });
    await importCodeFile(engine, 'src/other.ts',
      'export function helperz(): number {\n  return 2;\n}\n', { noEmbed: true });
    const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
    expect(stats.edges_resolved).toBeGreaterThanOrEqual(1);

    const chunksOf = async (path: string) => (await engine.executeRaw<{ id: number; symbol: string }>(
      `SELECT cc.id, cc.symbol_name_qualified AS symbol FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = $1 OR p.slug = $2`,
      [path, path.replace(/[/.]/g, '-')],
    ));
    const local = await chunksOf('src/local.ts');
    const other = await chunksOf('src/other.ts');
    const caller = local.find(c => c.symbol === 'callerz')!.id;
    const localHelper = local.find(c => c.symbol === 'helperz')!.id;
    const otherHelper = other.find(c => c.symbol === 'helperz')!.id;

    const ids = (await expandAnchors(engine, anchor(caller), { walkDepth: 1 })).map(e => e.chunk_id);
    expect(ids).toContain(localHelper);
    expect(ids).not.toContain(otherHelper);
  });
});

describe('Layer 7 (A2) — query operation schema', () => {
  test('query op exposes near_symbol + walk_depth params', async () => {
    const { operations } = await import('../src/core/operations.ts');
    const queryOp = operations.find(o => o.name === 'query');
    expect(queryOp).toBeDefined();
    expect(queryOp!.params.near_symbol).toBeDefined();
    expect(queryOp!.params.walk_depth).toBeDefined();
    expect(queryOp!.params.walk_depth!.type).toBe('number');
  });
});
