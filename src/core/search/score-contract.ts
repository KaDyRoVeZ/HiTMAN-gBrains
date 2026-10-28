/**
 * #7156: the returned `score` follows the returned order. Agents threshold
 * on it ("ignore below 0.8"), so a list whose rank 3 outscores its rank 1
 * reads as broken. In a reranked list the order is the rerank score (times
 * any rank prior, `rank_score`), so that becomes `score`; elsewhere `score`
 * already orders the list. Rows the order placed without a score of that
 * kind (identity and relational pins above the reranked head, the unreranked
 * tail, appended fact rows) take their neighbour's value, and a running
 * minimum keeps the column non-increasing. The value `score` held before
 * is kept as `fused_score` on every row it changed. Applied once, at the op
 * output boundary, so internal consumers still read the fused score.
 */
import type { SearchResult } from '../types.ts';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

export function scoresFollowRank<T extends Pick<SearchResult, 'score' | 'rerank_score' | 'rank_score' | 'fused_score' | 'relational_pinned'>>(rows: T[]): T[] {
  const reranked = rows.some(r => finite(r.rerank_score));
  const order = rows.map(r => (reranked ? (r.relational_pinned ? undefined : finite(r.rank_score) ? r.rank_score : r.rerank_score) : r.score));
  const first = order.find(finite);
  if (first === undefined) return rows;
  let prev = Infinity;
  let changed = false;
  const out = rows.map((r, i) => {
    const own = order[i];
    const value = Math.min(finite(own) ? own : prev === Infinity ? first : prev, prev);
    prev = value;
    if (value === r.score) return r;
    changed = true;
    return { ...r, score: value, ...(finite(r.score) && r.fused_score === undefined ? { fused_score: r.score } : {}) };
  });
  return changed ? out : rows;
}
