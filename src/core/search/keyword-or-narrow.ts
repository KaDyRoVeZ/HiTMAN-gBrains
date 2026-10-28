/**
 * Bounded keyword OR fallback (GBRA-156). When a keyword query's strict AND
 * finds nothing, the arm retries with the OR of its terms. ts_rank then runs
 * on every chunk holding any term: on a 2M-chunk brain a question with one
 * common word matched 100k-850k chunks and took 1-3.8 s, and the worst ran
 * into the 8 s keyword statement timeout, which drops the arm's rows.
 *
 * Postgres keeps per-lexeme row shares for `content_chunks.search_vector`
 * (`pg_stats.most_common_elems`, the statistics the planner prices a
 * tsquery with). The retry keeps every term the statistics do not track
 * (rare, so cheap to match, or absent), then adds the tracked terms rarest
 * first while their estimated matches stay within OR_FALLBACK_MATCH_CAP, and
 * always the rarest tracked one, so a retry never rests on terms that may
 * match nothing. It still ranks with the full OR query (searchKeyword binds
 * the rank query as its own parameter whenever it may relax), so a retained chunk
 * scores exactly as before; a chunk that holds only the dropped, most common
 * terms is no longer a candidate. Without statistics (never analyzed), or
 * when every term fits, the retry is unchanged.
 */

import { orFallbackTokens } from './sql-ranking.ts';

/** Estimated chunk matches the tracked terms of an OR retry may add: about 0.2 s of ts_rank on the 2M-chunk bench. */
export const OR_FALLBACK_MATCH_CAP = 20_000;

/**
 * A token's statistics: `lexemes` its lexeme count (0 for a stopword),
 * `share` the largest tracked row share among them, null when none is
 * tracked.
 */
export interface OrTokenShare { token: string; lexemes: number; share: number | null }

/**
 * Per-token statistics over `content_chunks.search_vector`, in token order,
 * plus the table's row estimate and whether the column has element
 * statistics at all. `$1` is the token array.
 */
export function orTokenSharesSql(ftsLang: string): string {
  return `WITH s AS (
      SELECT most_common_elems::text::text[] AS elems, most_common_elem_freqs AS freqs
      FROM pg_stats WHERE schemaname = current_schema() AND tablename = 'content_chunks' AND attname = 'search_vector'
    )
    SELECT u.token,
      (SELECT count(*) FROM unnest(to_tsvector('${ftsLang}', u.token)))::int AS lexemes,
      (SELECT max(s.freqs[array_position(s.elems, l.lexeme)]) FROM s, unnest(to_tsvector('${ftsLang}', u.token)) AS l) AS share,
      (SELECT reltuples FROM pg_class WHERE oid = 'content_chunks'::regclass)::float8 AS rows,
      EXISTS (SELECT 1 FROM s WHERE s.freqs IS NOT NULL) AS analyzed
    FROM unnest($1::text[]) WITH ORDINALITY AS u(token, ord)
    ORDER BY u.ord`;
}

/**
 * The tokens an OR retry should match, or null to keep every token: the
 * untracked ones, then tracked ones rarest first within `cap` estimated
 * rows (the rarest tracked one always), stopwords dropped. Null when no word
 * would be dropped.
 */
export function narrowOrFallbackTokens(tokens: OrTokenShare[], rows: number, cap = OR_FALLBACK_MATCH_CAP): string[] | null {
  if (!(rows > 0)) return null;
  const words = tokens.filter(t => t.lexemes > 0);
  const kept = words.filter(t => t.share === null).map(t => t.token);
  const tracked = words.filter(t => t.share !== null).sort((a, b) => a.share! - b.share!);
  let estimate = 0;
  for (const [i, t] of tracked.entries()) {
    estimate += t.share! * rows;
    if (i > 0 && estimate > cap) break;
    kept.push(t.token);
  }
  if (kept.length === 0 || kept.length === words.length) return null;
  return kept;
}

/**
 * The websearch text an OR retry of `query` should match, or null to match
 * the full OR query. `read` runs one statement; a failed statistics read
 * keeps every term.
 */
export async function narrowedOrFallbackQuery(
  read: (sql: string, params: unknown[]) => Promise<Array<{ token: string; lexemes: number; share: number | null; rows: number; analyzed: boolean }>>,
  query: string,
  ftsLang: string,
): Promise<string | null> {
  const shares = await read(orTokenSharesSql(ftsLang), [orFallbackTokens(query)]).catch(() => []);
  if (!shares[0]?.analyzed) return null;
  const kept = narrowOrFallbackTokens(shares.map(r => ({ token: r.token, lexemes: Number(r.lexemes), share: r.share === null ? null : Number(r.share) })), Number(shares[0].rows));
  return kept ? kept.join(' OR ') : null;
}
