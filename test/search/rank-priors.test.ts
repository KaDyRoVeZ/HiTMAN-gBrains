/**
 * Rank priors (#7155, #7162, #6058, #7153) and the score contract (#7156),
 * pure. Each prior needs a competitor of the preferred kind and a query of
 * the matching shape; without both the list is unchanged.
 */
import { describe, expect, test } from 'bun:test';
import { applyRankPriors, rankPriors, OCR_PRIOR, PERSON_PRIOR, REDIRECT_STUB_PRIOR, UNDATED_PRIOR } from '../../src/core/search/rank-priors.ts';
import { scoresFollowRank } from '../../src/core/search/score-contract.ts';
import type { SearchResult } from '../../src/core/types.ts';

const r = (slug: string, type: string, extra: Partial<SearchResult> = {}): SearchResult => ({
  slug, type, title: extra.title ?? slug.split('/').pop()!, page_id: 1, chunk_id: 1, chunk_index: 0, chunk_text: extra.chunk_text ?? slug,
  chunk_source: 'compiled_truth', score: 0.5, stale: false, source_id: 'default', ...extra,
});

describe('organization over person', () => {
  const founder = r('people/mara-example', 'person', { title: 'Mara Example', rerank_score: 0.82 });
  const company = r('companies/acme-example', 'company', { title: 'Acme Example', rerank_score: 0.78 });
  test('a product query that names no one puts the company first', () => {
    const out = applyRankPriors([founder, company], 'API startup that automates freight invoices for small carriers');
    expect(out.map(x => x.slug)).toEqual(['companies/acme-example', 'people/mara-example']);
    expect(out[1]).toMatchObject({ rank_prior: PERSON_PRIOR, rank_score: 0.82 * PERSON_PRIOR });
  });
  test('naming the person, asking who, or no org wording leaves the order', () => {
    for (const q of ['what did Mara build at the freight startup', 'who started the freight invoice company', 'freight invoices for small carriers']) {
      expect(applyRankPriors([founder, company], q).map(x => x.slug)).toEqual(['people/mara-example', 'companies/acme-example']);
    }
  });
  test('a quote request prefers the document over the speaker profile', () => {
    const talk = r('media/freight-talk', 'media', { rerank_score: 0.8 });
    expect(applyRankPriors([founder, talk], 'quote about moving fast on invoices').map(x => x.slug)).toEqual(['media/freight-talk', 'people/mara-example']);
  });
});

describe('image pages', () => {
  test('a caption matching one of two name words is weak; stamped image_page', () => {
    const img = r('images/2024-05-03-img-1234.jpg', 'note', { chunk_text: 'Sunset over the river, Mara on the left.', rerank_score: 0.9 });
    const person = r('people/mara-quill', 'person', { title: 'Mara Quill', chunk_text: 'Mara Quill leads finance.', rerank_score: 0.7 });
    const out = applyRankPriors([img, person], 'Mara Quill');
    expect(out.map(x => x.slug)).toEqual(['people/mara-quill', 'images/2024-05-03-img-1234.jpg']);
    expect(out[1]).toMatchObject({ image_page: true, rank_prior: OCR_PRIOR });
  });
  test('a caption that matches the whole query keeps its score', () => {
    const img = r('images/a.jpeg', 'image', { chunk_text: 'Mara Quill at the offsite' });
    expect(rankPriors([img], 'Mara Quill')).toEqual([1]);
  });
});

describe('temporal questions', () => {
  test('dated evidence beats an undated stub', () => {
    const stub = r('concepts/night-shift', 'concept', { score: 0.6 });
    const meeting = r('meetings/2025-02-01-ops', 'meeting', { score: 0.55, effective_date: '2025-02-01', effective_date_source: 'date' });
    expect(applyRankPriors([stub, meeting], 'when did the depot start the night shift').map(x => x.slug)).toEqual(['meetings/2025-02-01-ops', 'concepts/night-shift']);
    expect(rankPriors([stub, meeting], 'night shift staffing')).toEqual([1, 1]);
    expect(rankPriors([stub, meeting], 'when did the depot start')).toEqual([UNDATED_PRIOR, 1]);
  });
  test('a created-at fallback date is not a document date', () => {
    const a = r('notes/a', 'note', { effective_date: '2025-01-01', effective_date_source: 'created' });
    expect(rankPriors([a], 'when did it start')).toEqual([1]);
  });
});

describe('redirect stubs and the unchanged case', () => {
  test('a stub that kept its slot is demoted', () => {
    expect(rankPriors([r('concepts/a-old', 'concept-redirect', { redirect_to: 'a' })], 'a')).toEqual([REDIRECT_STUB_PRIOR]);
  });
  test('no prior: the same array comes back', () => {
    const rows = [r('notes/a', 'note'), r('notes/b', 'note')];
    expect(applyRankPriors(rows, 'anything at all')).toBe(rows);
  });
  test('unreranked lists multiply score and re-sort', () => {
    const founder = r('people/mara-example', 'person', { score: 0.5 });
    const company = r('companies/acme-example', 'company', { score: 0.45 });
    const out = applyRankPriors([founder, company], 'company that builds freight software');
    expect(out.map(x => x.slug)).toEqual(['companies/acme-example', 'people/mara-example']);
    expect(out[1].score).toBeCloseTo(0.5 * PERSON_PRIOR);
  });
});

describe('scoresFollowRank (#7156)', () => {
  test('a reranked list reports the rerank order value, keeping the fused score aside', () => {
    const rows: Array<{ score: number; rerank_score: number; fused_score?: number }> = [
      { score: 0.74, rerank_score: 0.875 },
      { score: 0.733, rerank_score: 0.875 },
      { score: 0.878, rerank_score: 0.801 },
    ];
    const out = scoresFollowRank(rows);
    expect(out.map(x => x.score)).toEqual([0.875, 0.875, 0.801]);
    expect(out.map(x => x.fused_score)).toEqual([0.74, 0.733, 0.878]);
  });
  test('pins above the head and an unreranked tail take neighbours; the column never rises', () => {
    const out = scoresFollowRank([
      { score: 0.02 },
      { score: 0.4, rerank_score: 0.6, rank_score: 0.51 },
      { score: 0.5, rerank_score: 0.55 },
      { score: 0.9 },
    ]);
    expect(out.map(x => x.score)).toEqual([0.51, 0.51, 0.51, 0.51]);
    for (let i = 1; i < out.length; i++) expect(out[i].score).toBeLessThanOrEqual(out[i - 1].score);
  });
  test('an already monotonic fused list is returned as is', () => {
    const rows = [{ score: 0.9 }, { score: 0.5 }];
    expect(scoresFollowRank(rows)).toBe(rows);
  });
});

describe('pins and feedback order survive the priors (review)', () => {
  const r = (slug: string, type: string, extra: Partial<SearchResult> = {}) => ({ slug, type, title: slug, chunk_text: slug, score: 0.5, page_id: 1, chunk_id: 1, chunk_index: 0, chunk_source: 'compiled_truth', stale: false, source_id: 'default', ...extra }) as SearchResult;
  test('a relational pin keeps rank 1 when an image row below it is demoted', () => {
    const rows = [
      r('people/alice-example', 'person', { relational_pinned: true, rerank_score: 0.05 }),
      r('images/badge.jpg', 'image', { rerank_score: 0.9, chunk_text: 'badge' }),
      r('notes/harbor-plan', 'note', { rerank_score: 0.7 }),
    ];
    const out = applyRankPriors(rows, 'who invested in harbor plan');
    expect(out[0].slug).toBe('people/alice-example');
    expect(out.map(x => x.slug)).toEqual(['people/alice-example', 'notes/harbor-plan', 'images/badge.jpg']);
  });
  test('unchanged rows keep their relative order even when it differs from rerank order', () => {
    const rows = [
      r('notes/b', 'note', { rerank_score: 0.6 }),
      r('notes/a', 'note', { rerank_score: 0.8 }),
      r('images/x.png', 'image', { rerank_score: 0.9, chunk_text: 'x' }),
    ];
    const out = applyRankPriors(rows, 'harbor depot rota');
    expect(out.map(x => x.slug)).toEqual(['notes/b', 'notes/a', 'images/x.png']);
  });
  test('a pinned row with a low rerank score does not flatten the column', () => {
    const out = scoresFollowRank([
      { score: 0.1, rerank_score: 0.1, relational_pinned: true },
      { score: 0.4, rerank_score: 0.9 },
      { score: 0.5, rerank_score: 0.7 },
    ]);
    expect(out.map(x => x.score)).toEqual([0.9, 0.9, 0.7]);
  });
});
