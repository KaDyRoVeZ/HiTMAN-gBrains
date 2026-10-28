/**
 * #7165: query-scoped coverage for search and query. A pending text projection
 * or a held file is brain state; whether it can change THIS answer depends on
 * the query. An item could affect a query when it is one of the returned pages,
 * its page type is one of the result types or the query's types, or its title,
 * slug or file path contains a query word. An empty result counts every item:
 * nothing rules it out, and an empty answer must never read as complete.
 *
 * Counted here: pending text projections (the readiness probe's unsealed pages
 * that need work) and pages held from embedding (a held or capped
 * page_embedding_budget row that still applies: no vectors, so the vector arm
 * cannot find them). Held files are counted by persistence/held-reads.ts.
 */
import type { BrainEngine } from '../engine.ts';
import { budgetRowAppliesFilter } from '../page-size-policy.ts';
import { projectionClassSql } from '../page-state/projection-class.ts';
import { pageReadFilter } from './read-policy-sql.ts';
import type { ProjectionReadinessScope } from './projection-readiness.ts';

/** Counts stop here (one bounded scan per call); a capped count reports `capped`. */
export const COVERAGE_COUNT_CAP = 1000;

export interface CoverageRelevance {
  all: boolean;
  types: string[];
  /** Lowercase LIKE patterns, one per query word. */
  patterns: string[];
  pageIds: number[];
  /** The top result's page when it is an exact slug, title or alias match for the query, else null. */
  exactTopPageId: number | null;
}

/** `_meta.retrieval.coverage`: counts in the read scope and how many of them could affect this query. */
export interface RetrievalCoverage {
  pending_projection?: number;
  held_files?: number;
  embedding_held?: number;
  could_affect: { pending_projection?: number; held_files?: number; embedding_held?: number };
  capped?: true;
  /** The top result is the page the query named (exact slug, title or alias) and its projection is current: pending pages are not counted as able to affect this answer. */
  top_hit_exact?: true;
}

export interface ScopedCount { total: number; could_affect: number; capped: boolean; /** With an exact top hit: whether that page is itself counted. */ top_counted?: boolean }

/** What could make a pending or held item relevant to this query (see the module comment). */
export function coverageRelevance(
  results: ReadonlyArray<{ type?: unknown; page_id?: unknown; exact_lookup?: unknown; alias_hit?: unknown }>,
  queryText: string,
  queryTypes: readonly string[] | undefined,
  stopwords: ReadonlySet<string>,
): CoverageRelevance {
  const terms = [...new Set(queryText.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]+/gu) ?? [])]
    .filter(t => t.length >= 3 && !stopwords.has(t)).slice(0, 12);
  return {
    all: results.length === 0,
    types: [...new Set([...(queryTypes ?? []), ...results.flatMap(r => (typeof r.type === 'string' ? [r.type] : []))])],
    patterns: terms.map(t => `%${t.replace(/[\\%_]/g, m => `\\${m}`)}%`),
    pageIds: [...new Set(results.flatMap(r => (typeof r.page_id === 'number' ? [r.page_id] : [])))],
    exactTopPageId: results[0] && (results[0].exact_lookup || results[0].alias_hit === true) && typeof results[0].page_id === 'number' ? results[0].page_id : null,
  };
}

/** The readiness probe's scope predicates over `pages p` (sources, visibility, kind, types, excluded prefixes), binding into `params`. */
export function coverageScopeFilters(scope: ProjectionReadinessScope, params: unknown[]): string[] {
  const filters = [pageReadFilter('p', scope, params, true)];
  if (scope.sourceIds?.length === 0) filters.push('FALSE');
  if (scope.pageKind) {
    params.push(scope.pageKind);
    filters.push(`p.page_kind = $${params.length}`);
  }
  if (scope.types) {
    params.push(scope.types);
    filters.push(`p.type = ANY($${params.length}::text[])`);
  }
  for (const prefix of scope.excludeSlugPrefixes ?? []) {
    params.push(prefix);
    filters.push(`LEFT(p.slug, LENGTH($${params.length}::text)) <> $${params.length}`);
  }
  return filters;
}

/** Pages in scope matching `where` (over `pages p` joined to `sources s` and `join`), up to the cap, and how many could affect the query. Null when the count fails: unknown, never zero. */
async function countInScope(engine: Pick<BrainEngine, 'executeRaw'>, scope: ProjectionReadinessScope, relevance: CoverageRelevance,
  join: string, where: string): Promise<ScopedCount | null> {
  const params: unknown[] = [];
  const filters = coverageScopeFilters(scope, params);
  params.push(relevance.all, relevance.types, relevance.patterns, relevance.pageIds);
  const n = params.length;
  const top = relevance.exactTopPageId;
  if (top !== null) params.push(top);
  try {
    const [row] = await engine.executeRaw<{ total: number | string; could_affect: number | string; top_counted?: boolean | null }>(
      `SELECT count(*)::int AS total,
        count(*) FILTER (WHERE $${n - 3}::boolean OR x.type = ANY($${n - 2}::text[]) OR x.haystack LIKE ANY($${n - 1}::text[]) OR x.id = ANY($${n}::int[]))::int AS could_affect${top === null ? '' : `,
        EXISTS (SELECT 1 FROM pages p JOIN sources s ON s.id = p.source_id ${join} WHERE p.id = $${n + 1}::int AND p.deleted_at IS NULL AND ${where}) AS top_counted`}
      FROM (SELECT p.id, p.type, lower(COALESCE(p.title, '') || ' ' || p.slug) AS haystack
        FROM pages p JOIN sources s ON s.id = p.source_id ${join}
        WHERE p.deleted_at IS NULL AND ${where} AND ${filters.join(' AND ')}
        LIMIT ${COVERAGE_COUNT_CAP}) x`,
      params,
    );
    const total = Number(row?.total), couldAffect = Number(row?.could_affect);
    if (!Number.isFinite(total) || !Number.isFinite(couldAffect)) return null;
    return { total, could_affect: couldAffect, capped: total >= COVERAGE_COUNT_CAP, ...(top === null ? {} : { top_counted: row?.top_counted === true }) };
  } catch {
    return null;
  }
}

/** The pending pages the readiness probe found (unsealed, needing work) in the same scope. */
export function countPendingProjections(engine: Pick<BrainEngine, 'executeRaw'>, scope: ProjectionReadinessScope, relevance: CoverageRelevance): Promise<ScopedCount | null> {
  return countInScope(engine, scope, relevance, '',
    `p.text_projection_revision IS DISTINCT FROM p.knowledge_revision AND ${projectionClassSql('p', 's')} NOT IN ('protected','archived')`);
}

/** Pages in scope held from embedding: a held or capped budget row that still applies, on a page no `embed_skip` marker keeps out of embedding for good. */
export function countEmbeddingHeld(engine: Pick<BrainEngine, 'executeRaw'>, scope: ProjectionReadinessScope, relevance: CoverageRelevance): Promise<ScopedCount | null> {
  return countInScope(engine, scope, relevance, 'JOIN page_embedding_budget b ON b.page_id = p.id',
    `${budgetRowAppliesFilter('b', 'p')} AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')`);
}
