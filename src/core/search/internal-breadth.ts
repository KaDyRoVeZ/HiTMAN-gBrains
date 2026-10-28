/**
 * Search options for internal callers that need the full ranked set (#5890).
 *
 * Autocut (score-cliff sizing) and adaptive return (intent cap: 2 pages for
 * entity queries, 6 otherwise) trim results for a human reader, before the
 * limit slice. Evidence gathering, close-set retrieval, expert ranking,
 * take grading and enrichment ask for a breadth-sized limit and apply their
 * own precision step, so both trims silently starve them. These callers
 * spread this object into their `hybridSearch` options.
 */
export const INTERNAL_BREADTH_SEARCH_OPTS = Object.freeze({
  autocut: false,
  adaptiveReturn: false,
} as const);
