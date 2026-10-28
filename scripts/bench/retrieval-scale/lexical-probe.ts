#!/usr/bin/env bun
/**
 * Lexical arm probe for the retrieval scale bench (GBRA-156): for N corpus
 * queries, times the keyword and title arms' strict statement and their OR
 * retry separately, and counts the chunks the OR query matches.
 *
 *   bun scripts/bench/retrieval-scale/lexical-probe.ts --url <direct postgres url> --pages <n> [--n 20] [--source default] [--compare-tree <checkout>]
 *
 * --compare-tree also runs the same call through another checkout's engine
 * (for example master) and reports how many of its result pages this tree
 * returns (top 50 and top 10) and this tree's top-10 score as a share of the
 * other's, which shows what a bounded candidate sample loses. --query adds a
 * query of your own (repeatable) after the sampled ones.
 */
import postgres from '#postgres';
import { buildOrFallbackWebsearchQuery } from '../../../src/core/search/sql-ranking.ts';

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const url = flag('--url')!;
const pages = Number(flag('--pages'));
const N = Number(flag('--n', '20'));
const source = flag('--source', 'default')!;
const compareTree = flag('--compare-tree');
const extra = argv.flatMap((a, i) => (a === '--query' ? [argv[i + 1]!] : []));

const { createEngine } = await import('../../../src/core/engine-factory.ts');
const engine = await createEngine({ engine: 'postgres' });
await engine.connect({ database_url: url });
const other = compareTree ? await (await import(compareTree + '/src/core/engine-factory.ts')).createEngine({ engine: 'postgres' }) : null;
if (other) await other.connect({ database_url: url });
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
const picks = await sql.unsafe("SELECT p.title, c.chunk_text FROM pages p JOIN content_chunks c ON c.page_id = p.id AND c.chunk_index = 0 WHERE p.id IN (SELECT 1 + ((g::bigint * 2654435761) % $1) FROM generate_series(1, $2) g) ORDER BY p.id", [pages, N]) as Array<{ title: string; chunk_text: string }>;
const time = async <T>(fn: () => Promise<T>) => { const t = performance.now(); try { const v = await fn(); return { ms: Math.round(performance.now() - t), v }; } catch (e) { return { ms: Math.round(performance.now() - t), v: null as T | null, err: (e as Error).message.slice(0, 60) }; } };
const queries = picks.map((p, i) => {
  const words = p.chunk_text.replace(/[^a-z\s]/gi, ' ').split(/\s+/).filter(w => w.length > 3);
  const k = 2 + (i % 3), at = (i * 7919) % Math.max(1, words.length - k);
  const titleWord = p.title.split(/\s+/).find(w => w.length > 3);
  return [...(i % 2 === 0 && titleWord ? [titleWord.toLowerCase()] : []), ...words.slice(at, at + k)].join(' ');
}).concat(extra);
type Row = { slug: string; source_id: string; score: number };
for (const [i, q] of queries.entries()) {
  const incomplete: string[] = [];
  const opts = { sourceIds: [source], limit: 50, onKeywordIncomplete: (r: string) => incomplete.push(r) } as Record<string, unknown>;
  const strictK = await time(() => engine.searchKeyword(q, opts as never));
  const orK = await time(() => engine.searchKeyword(q, { ...opts, orFallback: true } as never));
  const titles = await time(() => engine.searchTitles(q, { ...opts } as never));
  const base = other ? await time(() => other.searchKeyword(q, { ...opts, orFallback: true } as never)) : null;
  const key = (r: Row) => r.source_id + ':' + r.slug;
  const mine = (orK.v ?? []) as Row[], theirs = (base?.v ?? []) as Row[];
  const basePages = new Set(theirs.map(key)), base10 = new Set(theirs.slice(0, 10).map(key));
  const overlap = base ? mine.filter(r => basePages.has(key(r))).length : null;
  const overlap10 = base ? mine.slice(0, 10).filter(r => base10.has(key(r))).length : null;
  const top10 = (rows: Row[]) => rows.slice(0, 10).reduce((a, r) => a + Number(r.score), 0);
  const score10 = base && top10(theirs) > 0 ? Math.round((100 * top10(mine)) / top10(theirs)) / 100 : null;
  const orq = buildOrFallbackWebsearchQuery(q);
  const matches = orq ? await time(() => sql.unsafe("SELECT count(*)::int AS n FROM content_chunks WHERE search_vector @@ websearch_to_tsquery('english', $1)", [orq])) : null;
  console.log(JSON.stringify({ i, q: i >= picks.length ? q : undefined, terms: q.split(' ').length, strict_rows: strictK.v?.length ?? null, strict_ms: strictK.ms, or_path_ms: orK.ms, or_rows: orK.v?.length ?? null, or_err: (orK as any).err, title_ms: titles.ms, incomplete: incomplete.length > 0, ...(base ? { base_or_ms: base.ms, base_rows: basePages.size, base_err: (base as any).err, overlap, overlap10, score10 } : {}), or_matches: (matches?.v as any)?.[0]?.n ?? null, count_ms: matches?.ms }));
}
await sql.end();
await engine.disconnect();
await other?.disconnect();
