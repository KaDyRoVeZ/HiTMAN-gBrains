/**
 * Chain evidence survives delivery (pure).
 *
 * Protects: graph evidence rides on whichever chunk of a page survives fusion
 * (keyword may pick chunk 7 while the relational arm supplies chunk 1); arm
 * rows are never mutated; a chain's intermediate or origin page never claims
 * the relational pin or the page-1 slot meant for an answer; the token budget
 * counts the evidence edges; remote lean rows keep the evidence field.
 * Regression it catches: evidence dropped when another arm saw the page first,
 * a support page satisfying the answer guarantee, evidence stripped from lean
 * rows.
 */
import { describe, test, expect } from 'bun:test';
import { accumulateRrf } from '../../src/core/search/rrf-page-fusion.ts';
import { ensureRelationalEvidenceSlot } from '../../src/core/search/relational-recall.ts';
import { pinRelationalRows } from '../../src/core/search/relational-rerank-pin.ts';
import { resultTokens } from '../../src/core/search/token-budget.ts';
import { leanRow } from '../../src/core/search/lean-rows.ts';
import type { RelationalEvidence, SearchResult } from '../../src/core/types.ts';

function row(slug: string, chunkId: number, extra: Partial<SearchResult> = {}): SearchResult {
  return {
    slug, page_id: 0, title: slug, type: 'person', chunk_text: `text of ${slug}`, chunk_source: 'compiled_truth',
    chunk_id: chunkId, chunk_index: 0, score: 0.5, stale: false, source_id: 'default', ...extra,
  };
}

const evidence = (role: RelationalEvidence['role']): RelationalEvidence => ({
  role, seed: 'people/alice-example', hop: 2, path_count: 1,
  edges: [{ link_type: 'founded', stored_from: 'companies/acme-example', stored_to: 'people/bob-example', orientation: 'flipped', context: 'founded by bob', origin: null }],
});

describe('fusion carries graph evidence at page level', () => {
  test('a keyword row for another chunk of the page gains the chain evidence; arm rows stay untouched', () => {
    const kw = row('people/bob-example', 7);
    const chain = row('people/bob-example', 1, { relational: evidence('answer'), relational_seed: 'people/alice-example' });
    const entries = accumulateRrf([{ list: [kw], k: 60 }, { list: [chain], k: 60 }]);
    const kwEntry = entries.find(e => e.result.chunk_id === 7)!;
    expect(kwEntry.result.relational?.role).toBe('answer');
    expect(kwEntry.result.relational_seed).toBe('people/alice-example');
    expect(kw.relational).toBeUndefined();
  });

  test('pages the chain never reached gain nothing', () => {
    const entries = accumulateRrf([{ list: [row('people/carol-example', 3)], k: 60 }, { list: [row('people/bob-example', 1, { relational: evidence('answer') })], k: 60 }]);
    expect(entries.find(e => e.result.slug === 'people/carol-example')!.result.relational).toBeUndefined();
  });
});

describe('relational guarantees are for answers only', () => {
  const support = row('companies/acme-example', 2, { relational: evidence('support') });
  const answer = row('people/bob-example', 1, { relational: evidence('answer') });

  test('a support page on page 1 does not satisfy the slot; the answer is injected', () => {
    const pool = [row('a', 10), support, row('b', 11)];
    const r = ensureRelationalEvidenceSlot(pool, [support, answer], 3, 0);
    expect(r.decision).toMatchObject({ action: 'injected', slug: 'people/bob-example' });
  });

  test('the rerank pin never pins a support page', () => {
    const reranked = [row('a', 10), row('b', 11), support, answer];
    const out = pinRelationalRows(reranked, [support, answer], { max: 3 });
    expect(out[0].slug).toBe('people/bob-example');
    expect(out.find(r => r.slug === 'companies/acme-example')?.relational_pinned).toBeUndefined();
  });
});

describe('budget and lean rows', () => {
  test('token cost includes the evidence edges', () => {
    const plain = row('people/bob-example', 1);
    expect(resultTokens({ ...plain, relational: evidence('answer') })).toBeGreaterThan(resultTokens(plain));
  });

  test('lean rows keep the relational field', () => {
    const lean = leanRow({ ...row('people/bob-example', 1), relational: evidence('answer') } as unknown as Record<string, unknown>);
    expect(lean.relational).toBeDefined();
  });
});

describe('chain slots', () => {
  const answer = row('people/bob-example', 1, { relational: evidence('answer') });
  const support = row('companies/acme-example', 2, { relational: evidence('support') });

  test('a fired chain leads page 1 in arm order (answers, then evidence pages); the rest follows', () => {
    const pool = [row('a', 10, { score: 0.9 }), row('b', 11, { score: 0.8 }), { ...support, score: 0.1 }];
    const r = ensureRelationalEvidenceSlot(pool, [answer, support], 3, 0, undefined, 10);
    expect(r.pool.map(x => x.slug)).toEqual(['people/bob-example', 'companies/acme-example', 'a', 'b']);
    expect(r.decision).toMatchObject({ action: 'chain_pinned', count: 2 });
    expect(r.pool[0].score).toBeGreaterThan(r.pool[1].score);
    expect(r.pool[1].score).toBeGreaterThanOrEqual(r.pool[2].score);
  });

  test('no chain rows (one-hop arm): the single evidence slot applies as before', () => {
    const oneHop = row('people/carol-example', 3, { relational_seed: 'companies/acme-example' });
    const r = ensureRelationalEvidenceSlot([row('a', 10), row('b', 11)], [oneHop], 2, 0, undefined, 10);
    expect(r.decision?.action).toBe('injected');
  });

  test('later pages are untouched', () => {
    const pool = [row('a', 10)];
    expect(ensureRelationalEvidenceSlot(pool, [answer], 1, 1, undefined, 10).pool).toBe(pool);
  });
});
