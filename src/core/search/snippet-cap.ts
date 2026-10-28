/**
 * #3800: subagent token economy — cap the `chunk_text` payload of search
 * results at the OP layer (search + query), so an LLM tool loop reading
 * 20 results doesn't pay for 20 full chunks (~400 tokens each) when a
 * ~300-char snippet answers "is this the right page?". The full text is one
 * `get_page` away, and the marker tells the agent exactly that.
 *
 * Resolution (op layer): explicit `snippet_chars` param wins; else, when the
 * caller is a subagent tool loop (`ctx.viaSubagent`), the
 * `agent.search_snippet_chars` config applies (default 300; 0 = full text);
 * every other caller gets full text — this changes nothing for humans, MCP
 * clients, or internal consumers.
 *
 * Truncation is chunk_text-only and NON-mutating: results may be shared with
 * a pending semantic-cache write (hybridSearchCached stores fire-and-forget),
 * so capped copies are new objects — a truncated snippet must never be what
 * gets cached.
 */

/** Default snippet budget (chars) for subagent callers when config is unset. */
export const DEFAULT_AGENT_SNIPPET_CHARS = 300;

/**
 * #7164: the most chunk text one search/query row returns when the caller set
 * no snippet cap. The chunker stores at most a few thousand characters per
 * chunk; a chunk written before that cap can hold tens of thousands, which a
 * caller asking for ten rows never budgeted for. The marker names the window read
 * that returns the rest; `snippet_chars: 0` returns full text.
 */
export const RESULT_CHUNK_CHARS = 8000;

/** The cap for one call: an explicit `snippet_chars` (0 = full text) wins, then the resolved snippet cap, then RESULT_CHUNK_CHARS. */
export function resultChunkCap(snippetChars: unknown, snippetCap: number): number {
  if (typeof snippetChars === 'number' && Number.isFinite(snippetChars)) return snippetCap;
  return snippetCap > 0 ? snippetCap : RESULT_CHUNK_CHARS;
}

export function buildSnippetMarker(slug: string | undefined, droppedChars: number, followUp?: { op: string; args: Record<string, string> }, chunkId?: number): string {
  // Large pages: a hit past the first chunk points at its own window (get_page around_chunk_id), not at the whole page.
  if (!followUp && slug && Number.isSafeInteger(chunkId) && (chunkId as number) > 0) {
    return `… [truncated ${droppedChars} chars — get_page ${slug} around_chunk_id=${chunkId}]`;
  }
  const target = followUp ? `${followUp.op} ${JSON.stringify(followUp.args)}` : slug && slug.length > 0 ? `get_page ${slug}` : 'get_page <slug>';
  return `… [truncated ${droppedChars} chars — ${target} for full text]`;
}

/**
 * Cap each result's `chunk_text` at `chars` characters, appending a marker
 * naming the recovery move. `chars <= 0` (or non-finite) means "no cap".
 * Returns the ORIGINAL array (same object identities) when nothing needed
 * truncation, so untouched paths stay allocation-free.
 */
export function applySnippetCap<T extends { chunk_text?: unknown; slug?: unknown; chunk_id?: unknown; chunk_index?: unknown; follow_up?: { op: string; args: Record<string, string> } }>(
  results: T[],
  chars: number,
): T[] {
  if (!Number.isFinite(chars) || chars <= 0) return results;
  let anyTruncated = false;
  const out = results.map((r) => {
    const text = r.chunk_text;
    if (typeof text !== 'string' || text.length <= chars) return r;
    anyTruncated = true;
    const slug = typeof r.slug === 'string' ? r.slug : undefined;
    return {
      ...r,
      chunk_text: text.slice(0, chars) + buildSnippetMarker(slug, text.length - chars, r.follow_up,
        typeof r.chunk_index === 'number' && r.chunk_index > 0 && typeof r.chunk_id === 'number' ? r.chunk_id : undefined),
    };
  });
  return anyTruncated ? out : results;
}
