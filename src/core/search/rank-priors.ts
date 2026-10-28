/**
 * Rank priors (#7155, #7162, #6058, #7153): small, query-gated multipliers on
 * a row's ordering score, applied after the reranker so they shape the order
 * the caller reads. In a reranked list the ordering score is the rerank score
 * (stamped `rank_score` = rerank_score x prior) and only the rerank-scored
 * rows reorder among themselves; otherwise `score` itself is multiplied and
 * the list re-sorted. Every prior needs a competitor of the preferred kind
 * in the same list, so a list with nothing to prefer is unchanged.
 *   - organization over person: a query that describes a company or
 *     product, names no person in the list and doesn't ask for one moves
 *     person pages below company pages that score close to them; a request for a quote or statement prefers the
 *     document that holds it over the speaker's profile.
 *   - image pages: a text row of an image page (a short caption or OCR
 *     text) matching at most half of the query's words is a weak match (row
 *     stamped `image_page`).
 *   - temporal: a "when did ..." question prefers rows with a document or
 *     event date over undated ones.
 *   - redirect stubs that could not be replaced by their target (`redirect_to`).
 * `search.rank_priors false` turns them off.
 */
import type { SearchResult } from '../types.ts';

export const PERSON_PRIOR = 0.85;
export const OCR_PRIOR = 0.6;
export const UNDATED_PRIOR = 0.85;
export const REDIRECT_STUB_PRIOR = 0.5;

const PERSON_TYPES = new Set(['person']);
const ORG_TYPES = new Set(['company', 'organization', 'org', 'startup', 'product']);
const DOCUMENT_TYPES = new Set(['media', 'meeting', 'conversation', 'transcript', 'source', 'writing', 'note', 'email', 'slack', 'podcast', 'video', 'talk']);
const ASKS_FOR_PERSON = /\b(who|whom|whose|person|people|founder|founders|co-?founder|ceo|cto|cfo|coo|partner|investor|engineer|bio|biography|background|contact|email|phone)\b/i;
const ASKS_FOR_ORG = /\b(company|companies|startup|startups|business|businesses|firm|product|products|platform|api|apis|app|apps|tool|tools|service|services|software|saas|marketplace|provider|vendor|brand|maker|manufacturer|organization|organisation|org|nonprofit|lab|agency|studio|builds|makes|sells|offers)\b/i;
const ASKS_FOR_QUOTE = /\b(quote|quoted|quotes|said|says|saying|statement|remark|remarks|told)\b/i;
const TEMPORAL = /^\s*when\b|\bwhat (?:date|day|month|year)\b|\bsince when\b|\bhow long ago\b/i;
const DATED_SOURCES = new Set(['date', 'published', 'filename', 'event_date']);
const IMAGE_SLUG = /\.(?:jpe?g|png|gif|webp|heic|heif|tiff?)$/i;
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'from', 'is', 'are', 'was', 'were', 'did', 'does', 'do', 'what', 'when', 'where', 'which', 'how', 'who', 'about', 'that', 'this']);

const words = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

function isImageRow(r: SearchResult): boolean {
  return r.type === 'image' || IMAGE_SLUG.test(r.slug);
}

function isDated(r: SearchResult): boolean {
  return !!r.effective_date && DATED_SOURCES.has(r.effective_date_source ?? '');
}

/** True when a query word is a name word of some person page in the list. */
function namesListedPerson(queryWords: Set<string>, rows: SearchResult[]): boolean {
  for (const r of rows) {
    if (!PERSON_TYPES.has(r.type)) continue;
    const name = [...words(r.title ?? ''), ...words(r.slug.split('/').pop() ?? '')];
    if (name.some(w => w.length >= 3 && !STOP.has(w) && w !== 'example' && queryWords.has(w))) return true;
  }
  return false;
}

/** Share of the query's content words found in the text. */
function coverage(queryWords: string[], text: string): number {
  if (queryWords.length === 0) return 1;
  const have = new Set(words(text));
  return queryWords.filter(w => have.has(w)).length / queryWords.length;
}

/** The prior for each row (1 = none), computed against the whole list. */
export function rankPriors(rows: SearchResult[], query: string): number[] {
  const qList = words(query);
  const qWords = new Set(qList);
  const content = qList.filter(w => !STOP.has(w));
  const types = new Set(rows.map(r => r.type));
  const has = (set: Set<string>) => [...types].some(t => set.has(t));
  const personDemoted = has(PERSON_TYPES) && !namesListedPerson(qWords, rows) && (
    (has(ORG_TYPES) && ASKS_FOR_ORG.test(query) && !ASKS_FOR_PERSON.test(query)) || (ASKS_FOR_QUOTE.test(query) && has(DOCUMENT_TYPES)));
  const temporal = TEMPORAL.test(query) && rows.some(isDated) && rows.some(r => !isDated(r));
  return rows.map(r => {
    let prior = 1;
    if (personDemoted && PERSON_TYPES.has(r.type)) prior *= PERSON_PRIOR;
    if (isImageRow(r) && coverage(content, r.chunk_text ?? '') <= 0.5) prior *= OCR_PRIOR;
    if (temporal && !isDated(r)) prior *= UNDATED_PRIOR;
    if (r.redirect_to) prior *= REDIRECT_STUB_PRIOR;
    return prior;
  });
}

/** Apply the priors (module comment). Returns a new array; changed rows are copies. */
export function applyRankPriors(rows: SearchResult[], query: string): SearchResult[] {
  if (rows.length === 0) return rows;
  const priors = rankPriors(rows, query);
  if (priors.every(p => p === 1) && !rows.some(isImageRow)) return rows;
  const stamped = rows.map((r, i) => {
    const image = isImageRow(r) ? { image_page: true as const } : {};
    return priors[i] === 1 && !image.image_page ? r : { ...r, ...image, ...(priors[i] !== 1 ? { rank_prior: priors[i] } : {}) };
  });
  if (priors.every(p => p === 1)) return stamped;
  const reranked = stamped.some(r => Number.isFinite(r.rerank_score));
  for (let i = 0; i < stamped.length; i++) {
    if (priors[i] === 1) continue;
    if (!reranked) stamped[i] = { ...stamped[i], score: stamped[i].score * priors[i] };
    else if (Number.isFinite(stamped[i].rerank_score)) stamped[i] = { ...stamped[i], rank_score: stamped[i].rerank_score! * priors[i] };
  }
  const value = (r: SearchResult) => (reranked ? r.rank_score ?? r.rerank_score! : r.score);
  // Pinned rows and (in a reranked list) rows without a rerank score keep their slots.
  const slots = stamped.map((r, i) => i).filter(i => !stamped[i].relational_pinned && (!reranked || Number.isFinite(stamped[i].rerank_score)));
  // Unchanged rows keep their relative order (feedback and any later adjustment included); a demoted row moves
  // down to before the first unchanged-or-placed row whose order value is below its own.
  const seq = slots.filter(i => priors[i] === 1).map(i => stamped[i]);
  for (const i of slots.filter(i => priors[i] !== 1)) {
    const at = seq.findIndex(r => value(r) < value(stamped[i]));
    seq.splice(at < 0 ? seq.length : at, 0, stamped[i]);
  }
  slots.forEach((slot, n) => { stamped[slot] = seq[n]; });
  return stamped;
}
