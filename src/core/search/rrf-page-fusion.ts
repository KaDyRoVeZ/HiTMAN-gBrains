/**
 * Page-grain RRF accumulation shared by `rrfFusion` and `rrfFusionWeighted`
 * (hybrid.ts). Pure: no engine, no I/O.
 */

import type { SearchResult } from '../types.ts';

/**
 * RRF/dedup identity for a result row, at chunk granularity.
 *
 * Includes `source_id` so two same-slug pages in different federated sources
 * don't collapse into one fusion entry (the same composite-key discipline
 * `dedup.ts:pageKey` already uses at page granularity). Pre-fix the key was
 * `slug:chunk_id`, which silently merged cross-source rows and let a
 * synthetic chunkless row (chunk_id null) key on a text prefix; the
 * `(source_id, slug, chunk_id)` shape is collision-safe for both.
 */
function rrfKey(r: SearchResult): string {
  const source = r.source_id ?? 'default';
  return `${source}:${r.slug}:${r.chunk_id ?? r.chunk_text.slice(0, 50)}`;
}

/**
 * RRF vote identity: the page, `(source_id, slug)`. Every arm is page-grain
 * (best chunk per page) but each arm picks its OWN representative chunk, so
 * voting on the chunk key split one page's cross-arm agreement across
 * several fusion entries (a page ranked #1 by keyword and by vector lost to
 * a page ranked #2 by both). Votes sum per page — each list counts a page
 * once, at its best rank — and the page's LEAD chunk (largest own vote; ties
 * go to the first list that surfaced it, which is a vector arm in
 * `composeFusionLists` order, i.e. the page's best-cosine chunk) carries the
 * page's summed score. The page's other chunks keep their own votes, so a
 * page's second chunk never crowds out another page's lead in a chunk-limited
 * result (giving every chunk the page score cost multi-session recall).
 */
function rrfPageKey(r: SearchResult): string {
  return `${r.source_id ?? 'default'}:${r.slug}`;
}

/**
 * One fusion vote, for explain attribution: which arm instance voted, at
 * which 0-based list rank, with what k / weight and contribution
 * (`weight / (k + rank)`). `vote: 'page'` = the page-level vote the lead chunk
 * carries (the page's best-ranked chunk in that list, `chunk_id` names it);
 * `vote: 'chunk'` = this chunk's own vote.
 */
export interface RrfArmVote {
  arm: string;
  rank: number;
  k: number;
  weight: number;
  contribution: number;
  vote: 'page' | 'chunk';
  chunk_id?: number;
}

export type RrfEntry = { result: SearchResult; score: number; own: number; keywordHit: boolean; arms: RrfArmVote[] };

/**
 * Shared accumulation for both RRF fusers: chunk entries (identity and
 * keyword-hit OR-propagation) plus page vote totals. Returns chunk entries in
 * first-seen order; each page's lead scores the page total, the rest their
 * own vote.
 */
export function accumulateRrf(lists: ReadonlyArray<{ list: SearchResult[]; k: number; weight?: number; arm?: string }>): RrfEntry[] {
  const chunks = new Map<string, RrfEntry>();
  const pages = new Map<string, number>();
  // Graph evidence is page-level: the relational arm may surface a page's
  // canonical chunk while keyword/vector pick another chunk of the same page,
  // so the evidence rides on whichever of the page's rows survives.
  const graphEvidence = new Map<string, Partial<SearchResult>>();
  const pageVotes = new Map<string, RrfArmVote[]>();
  for (let li = 0; li < lists.length; li++) {
    const { list, k, weight } = lists[li];
    const arm = lists[li].arm ?? `list#${li + 1}`;
    const w = weight ?? 1;
    const votedPages = new Set<string>();
    for (let rank = 0; rank < list.length; rank++) {
      const r = list[rank];
      const rrfScore = w / (k + rank);
      const page = rrfPageKey(r);
      const vote: RrfArmVote = { arm, rank, k, weight: w, contribution: rrfScore, vote: 'chunk' };
      if (!votedPages.has(page)) {
        votedPages.add(page);
        pages.set(page, (pages.get(page) ?? 0) + rrfScore);
        const pv = pageVotes.get(page) ?? [];
        pv.push({ ...vote, vote: 'page', ...(typeof r.chunk_id === 'number' ? { chunk_id: r.chunk_id } : {}) });
        pageVotes.set(page, pv);
      }
      if (!graphEvidence.has(page) && (r.relational !== undefined || r.relational_seed !== undefined)) {
        graphEvidence.set(page, pickGraphEvidence(r));
      }
      const key = rrfKey(r);
      const existing = chunks.get(key);
      if (existing) {
        existing.own += rrfScore;
        existing.arms.push(vote);
        // #3783 — OR-propagate lexical-arm membership: a row that fusion
        // first saw via a vector list must still read keyword_hit when the
        // keyword arm ALSO surfaced it.
        if (r.keyword_hit === true) existing.keywordHit = true;
        // A strict appearance in any list outranks the OR-relaxed fallback:
        // the fused row is relaxed only when every list that held it was.
        if (existing.result.keyword_relaxed === true && r.keyword_relaxed !== true) {
          const { keyword_relaxed: _relaxed, ...strict } = existing.result;
          existing.result = strict;
        }
      } else {
        chunks.set(key, { result: r, score: 0, own: rrfScore, keywordHit: r.keyword_hit === true, arms: [vote] });
      }
    }
  }
  const entries = Array.from(chunks.values());
  for (const e of entries) {
    const evidence = graphEvidence.get(rrfPageKey(e.result));
    if (evidence && e.result.relational === undefined && e.result.relational_seed === undefined) {
      e.result = { ...e.result, ...evidence };
    }
  }
  const leads = new Map<string, RrfEntry>();
  for (const e of entries) {
    e.score = e.own;
    const page = rrfPageKey(e.result);
    const lead = leads.get(page);
    if (!lead || e.own > lead.own) leads.set(page, e);
  }
  for (const [page, lead] of leads) {
    lead.score = pages.get(page) ?? lead.own;
    lead.arms = pageVotes.get(page) ?? lead.arms;
  }
  return entries;
}

const GRAPH_EVIDENCE_FIELDS = ['relational', 'relational_seed', 'relational_hop', 'relational_path', 'relational_via_link_types'] as const;

function pickGraphEvidence(r: SearchResult): Partial<SearchResult> {
  const out: Record<string, unknown> = {};
  for (const f of GRAPH_EVIDENCE_FIELDS) if (r[f] !== undefined) out[f] = r[f];
  return out as Partial<SearchResult>;
}
