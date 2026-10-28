/**
 * One filter hint per search/query (#7159): agents rarely find `types`,
 * `since`/`until` and `where`, so when a call looks like it wanted one,
 * the response carries one `search_filter_hint` notice naming the filter and
 * the exact next call. It never changes the results.
 *
 * Rules, first match wins, none when the caller already filtered that axis:
 *  1. The query names a page type the brain has pages of (the active schema
 *     pack's type names and aliases, singular or plural) and the top rows are
 *     not already mostly that type: suggest `types: [<type>]`.
 *  2. The query has a date word (a year, a month, "last week", "recent"…):
 *     suggest `since`/`until` (`search` has none, so it points at `query`).
 *  3. At least 8 rows came back and 9 in 10 of the top ten share one type the
 *     query does not name: say so and list other types to filter by.
 * First page only. Deduped per session per suggestion on MCP.
 */
import type { Notice } from '../agent-output.ts';
import type { BrainEngine } from '../engine.ts';
import { readFix } from '../ops/op-fix.ts';
import { loadActivePackForEngine } from '../schema-pack/engine-resolution.ts';

export interface FilterHintInput {
  op: 'search' | 'query';
  query: string;
  rows: ReadonlyArray<{ type?: string | null }>;
  /** Type names the brain declares (pack names and aliases). */
  packTypes: readonly string[];
  /** Whether the brain holds a page of this type. */
  hasPages: (type: string) => Promise<boolean>;
  filtered: { types: boolean; dates: boolean };
}

const DATE_WORDS = /\b((19|20)\d{2}|q[1-4]|jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sept?(ember)?|oct(ober)?|nov(ember)?|dec(ember)?|spring|summer|autumn|fall|winter|today|yesterday|recent(ly)?|latest|ago|(last|this|past|next) (week|month|quarter|year))\b/i;
const TOP = 10;

const words = (text: string) => ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, ' ')} `;

/** The forms of a type name a query may use: `meeting`, `meetings`, `office hours` for `office-hours`, `companies`. */
function typeForms(type: string): string[] {
  const base = type.toLowerCase().replace(/[-_]+/g, ' ');
  return [base, `${base}s`, `${base}es`, base.replace(/y$/, 'ies')];
}

function share(rows: FilterHintInput['rows'], type: string): number {
  const top = rows.slice(0, TOP);
  return top.length === 0 ? 0 : top.filter(r => r.type === type).length / top.length;
}

export async function filterHint(input: FilterHintInput): Promise<Notice | null> {
  const q = words(input.query);
  const named = input.packTypes.filter(t => typeForms(t).some(form => q.includes(` ${form} `)));
  const cli = (args: string[]) => ['gbrain', input.op, input.query, ...args];
  if (!input.filtered.types) {
    for (const type of named) {
      if (share(input.rows, type) >= 0.8 || !await input.hasPages(type).catch(() => false)) continue;
      return {
        code: 'search_filter_hint', kind: 'info', dedupe_key: `types:${type}`,
        why: `The query names the page type "${type}"; types: ["${type}"] (CLI --types ${type}) returns only ${type} pages.`,
        fix: readFix(`Repeat the ${input.op} restricted to ${type} pages.`, { argv: cli(['--types', type]), mcp: { tool: input.op, arguments: { query: input.query, types: [type] } } }),
      };
    }
  }
  if (!input.filtered.dates && DATE_WORDS.test(input.query)) {
    const why = input.op === 'query'
      ? 'The query names a time; since/until (CLI --since YYYY-MM-DD, --until) restrict results to pages dated in that window.'
      : 'The query names a time; search has no date filter, query takes since/until (CLI --since YYYY-MM-DD, --until) for pages dated in that window.';
    return {
      code: 'search_filter_hint', kind: 'info', dedupe_key: 'dates', why,
      fix: readFix('Repeat it as a query with a date window (fill in the dates).', { argv: ['gbrain', 'query', input.query, '--since', 'YYYY-MM-DD'], mcp: { tool: 'query', arguments: { query: input.query, since: 'YYYY-MM-DD' } } }),
    };
  }
  if (input.filtered.types || input.rows.length < 8) return null;
  const dominant = input.rows[0]?.type;
  if (!dominant || share(input.rows, dominant) < 0.9 || named.includes(dominant)) return null;
  const others = input.packTypes.filter(t => t !== dominant).slice(0, 8);
  if (others.length === 0) return null;
  return {
    code: 'search_filter_hint', kind: 'info', dedupe_key: `dominant:${dominant}`,
    why: `The top results are almost all "${dominant}" pages. To read another kind, pass types (CLI --types <type>); this brain's types include ${others.join(', ')}. Frontmatter fields filter with where (CLI --where key=value).`,
  };
}

/** The brain's declared type names for the hint (pack names and aliases); empty when no pack loads. */
export async function packTypeNames(engine: BrainEngine, sourceId: string | undefined): Promise<string[]> {
  try {
    const pack = await loadActivePackForEngine(engine, { remote: true, sourceId });
    return [...new Set(pack.manifest.page_types.flatMap(t => [t.name, ...(t.aliases ?? [])]))];
  } catch {
    return [];
  }
}

/** Whether the caller can see any page of this type: one listing row under the caller's own source and private-page scope. */
export async function callerHasType(engine: BrainEngine, type: string, scope: { sourceId?: string; sourceIds?: string[]; excludePrivate: boolean }): Promise<boolean> {
  return (await engine.listPages({ type, limit: 1, listColumnsOnly: true, ...scope })).length > 0;
}

/** The op-side wrapper: the hint for a search/query first page, or null (never throws). */
export async function searchFilterHint(ctx: { engine: BrainEngine; sourceId?: string }, scope: { sourceId?: string; sourceIds?: string[] }, excludePrivate: boolean,
  query: string, rows: ReadonlyArray<{ type?: string | null }>, types: string[] | undefined, call: { op: 'search' | 'query'; p: Record<string, unknown> }): Promise<Notice | null> {
  if (!query.trim() || Number(call.p.offset ?? 0) > 0 || call.p.cursor !== undefined) return null;
  try {
    return await filterHint({
      op: call.op, query, rows,
      packTypes: await packTypeNames(ctx.engine, scope.sourceId ?? scope.sourceIds?.[0] ?? ctx.sourceId),
      hasPages: type => callerHasType(ctx.engine, type, { ...scope, excludePrivate }),
      filtered: { types: (types?.length ?? 0) > 0, dates: typeof call.p.since === 'string' || typeof call.p.until === 'string' },
    });
  } catch {
    return null;
  }
}
