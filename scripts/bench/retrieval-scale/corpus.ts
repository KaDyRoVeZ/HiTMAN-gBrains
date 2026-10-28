#!/usr/bin/env bun
/**
 * Retrieval scale bench, step 1: a large synthetic Postgres brain (GBRA-156).
 * Opt-in bench code, never run in CI (the CI latency check is
 * test/e2e/retrieval-latency.test.ts at a size CI can afford).
 *
 *   bun scripts/bench/retrieval-scale/corpus.ts --url postgresql://postgres:postgres@127.0.0.1:5434/postgres \
 *     --db bench_retrieval_300k --pages 300000 [--workers 8] [--seed 7] [--out manifest.json]
 *
 * Builds a fresh database with initSchema, then streams brain-shaped pages
 * into two large sources and one small one (52% / 43% / 5%), with a share of
 * cross-source twins (the same slug in two sources), page types, dated
 * frontmatter, links and timeline rows, and chunks with real-width unit
 * vectors from the synthetic-latent geometry of hnsw-latent-corpus.ts (no
 * network or model calls). Chunk-table indexes are dropped for the load and
 * rebuilt afterwards with the exact definitions initSchema created, so the
 * served brain matches a migrated one. Everything is generated words and
 * placeholder names; nothing comes from a real brain.
 */
import { writeFileSync } from 'node:fs';
import postgres from '#postgres';
import { buildBasis, hash32, LATENT_DEFAULTS, planPages, Rng, type LatentParams, loadLatentCorpus, chunkText } from '../hnsw-latent-corpus.ts';

const argv = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const adminUrl = flag('--url');
const dbName = flag('--db', 'bench_retrieval');
const pagesWanted = Number(flag('--pages', '30000'));
const workers = Number(flag('--workers', '4'));
const seed = Number(flag('--seed', '7'));
const out = flag('--out');
const model = flag('--model', 'openai:text-embedding-3-large')!;
if (!adminUrl) { console.error('--url <postgres admin url> is required'); process.exit(2); }
if (!/^[a-z0-9_]+$/.test(dbName!)) { console.error('--db must be [a-z0-9_]+'); process.exit(2); }

const t0 = performance.now();
const log = (m: string) => console.error('[retrieval-corpus +' + ((performance.now() - t0) / 1000).toFixed(1) + 's] ' + m);

export const SOURCES = ['default', 'source-b', 'source-c'] as const;
export const SHARES: [number, number] = [0.52, 0.43];
export const TWIN_SHARE = 0.1;
export const TYPES: Array<[string, string, number]> = [
  ['person', 'people', 0.15], ['company', 'companies', 0.08], ['meeting', 'meetings', 0.2], ['note', 'notes', 0.25],
  ['concept', 'concepts', 0.1], ['transcript', 'transcripts', 0.12], ['original', 'originals', 0.1],
];
const FIRST = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan', 'judy', 'mallory', 'niaj', 'olivia', 'peggy', 'rupert', 'sybil', 'trent', 'victor', 'walter', 'yolanda'];
const SYL = ['ka', 'lo', 'mi', 'ten', 'ar', 'vis', 'no', 're', 'shu', 'pa', 'der', 'qui', 'lan', 'mo', 'zet', 'ri', 'bo', 'ex', 'ul', 'fen'];
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
function word(rng: Rng) { let w = ''; const n = 2 + Math.floor(rng.next() * 2); for (let i = 0; i < n; i++) w += SYL[Math.floor(rng.next() * SYL.length)]; return w; }

export interface PageMeta { id: number; source: string; slug: string; type: string; title: string; date: string }

/** Deterministic page header: type, title, slug and date for page index p. */
export function pageMeta(p: number, source: number): PageMeta {
  const rng = new Rng(hash32(seed, p, 0x7a9e));
  let r = rng.next(), ti = 0;
  while (ti < TYPES.length - 1 && r > TYPES[ti]![2]) { r -= TYPES[ti]![2]; ti++; }
  const [type, dir] = TYPES[ti]!;
  const surname = word(rng), w1 = word(rng), w2 = word(rng);
  const first = FIRST[Math.floor(rng.next() * FIRST.length)]!;
  const date = new Date(Date.UTC(2021, 0, 1) + Math.floor(rng.next() * 1800) * 86_400_000).toISOString().slice(0, 10);
  const title = type === 'person' ? cap(first) + ' ' + cap(surname)
    : type === 'company' ? cap(w1) + cap(w2) + ' Example'
    : type === 'meeting' ? 'Meeting with ' + cap(first) + ' ' + cap(surname) + ' on ' + w1
    : type === 'transcript' ? 'Transcript ' + date + ' ' + w1 + ' ' + w2
    : cap(w1) + ' ' + w2 + ' ' + surname;
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return { id: p + 1, source: SOURCES[source]!, slug: dir + '/' + base + '-' + p.toString(36), type, title, date };
}

async function main() {
  const admin = postgres(adminUrl!, { max: 1, prepare: false, onnotice: () => {} });
  await admin.unsafe('DROP DATABASE IF EXISTS ' + dbName + ' WITH (FORCE)');
  await admin.unsafe('CREATE DATABASE ' + dbName);
  await admin.end();
  const target = new URL(adminUrl!);
  target.pathname = '/' + dbName;
  const url = target.toString();

  const chunksWanted = Math.round(pagesWanted * 7.13);
  const params: LatentParams = { ...LATENT_DEFAULTS, chunks: chunksWanted, dims: 1536, seed, sourceShares: SHARES };
  const plan = planPages(chunksWanted, seed, SHARES);
  log('plan: ' + plan.count + ' pages, ' + chunksWanted + ' chunks');

  const { createEngine } = await import('../../../src/core/engine-factory.ts');
  const engine = await createEngine({ engine: 'postgres' });
  await engine.connect({ database_url: url });
  await (engine as unknown as { initSchema(o: unknown): Promise<void> }).initSchema({ embedding: { dimensions: 1536, model } });
  await engine.disconnect();
  log('initSchema done');

  const sql = postgres(url, { max: workers + 2, prepare: false, onnotice: () => {} });
  for (const s of SOURCES) await sql.unsafe("INSERT INTO sources (id, name, config) VALUES ($1, $1, '{\"federated\": true}') ON CONFLICT (id) DO NOTHING", [s]);

  // Pages: text COPY in one stream. Twins in source-b reuse the slug of an earlier source-a page.
  const firstA: number[] = [];
  const twinned = new Set<number>();
  const metas: PageMeta[] = new Array(plan.count);
  for (let p = 0; p < plan.count; p++) {
    const m = pageMeta(p, plan.source[p]!);
    if (plan.source[p] === 0 && firstA.length < plan.count) firstA.push(p);
    if (plan.source[p] === 1 && firstA.length > 0 && (hash32(seed, p, 0x7713) % 1000) < TWIN_SHARE * 1000) {
      const twinIndex = firstA[hash32(seed, p, 0x7714) % firstA.length]!;
      if (!twinned.has(twinIndex)) {
        twinned.add(twinIndex);
        const twin = metas[twinIndex]!;
        m.slug = twin.slug; m.type = twin.type; m.title = twin.title;
      }
    }
    metas[p] = m;
  }
  log('metas built');
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  const pageCopy = await sql.unsafe('COPY pages (id, source_id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, effective_date, effective_date_source, created_at, updated_at, trust_tier) FROM STDIN').writable();
  const pagesDone = new Promise<void>((res, rej) => { pageCopy.on('finish', res); pageCopy.on('error', (e: Error) => { log('page COPY failed: ' + e.message); rej(e); }); });
  pagesDone.catch(() => {});
  log('copy stream open');
  let buf = '';
  for (let p = 0; p < plan.count; p++) {
    const m = metas[p]!;
    const body: string[] = [];
    for (let c = 0; c < plan.chunkCount[p]!; c++) body.push(chunkText(seed, p, c, plan.topic[p]!));
    const truth = '# ' + m.title + '\n\n' + body.join('\n\n');
    const timeline = m.type === 'meeting' || m.type === 'person' ? '- **' + m.date + '** | ' + m.title + ' follow-up' : '';
    const fm = JSON.stringify({ type: m.type, title: m.title, date: m.date, tags: [word(new Rng(hash32(seed, p, 0x7a6)))], status: (p % 3 === 0 ? 'active' : 'archived') });
    const at = m.date + 'T12:00:00Z';
    buf += [m.id, m.source, esc(m.slug), m.type, esc(m.title), esc(truth), esc(timeline), esc(fm), hash32(seed, p, 0xc0de).toString(16), at, 'date', at, at, 'operator_curated'].join('\t') + '\n';
    if (buf.length > 4 << 20) { const chunk = buf; buf = ''; await new Promise<void>((res, rej) => pageCopy.write(chunk, (e?: Error | null) => e ? rej(e) : res())); }
  }
  await new Promise<void>((res, rej) => pageCopy.write(buf, (e?: Error | null) => e ? rej(e) : res()));
  pageCopy.end();
  await pagesDone;
  await sql.unsafe("SELECT setval(pg_get_serial_sequence('pages', 'id'), (SELECT max(id) FROM pages))");
  const { titleTierCorpusGeneration } = await import('../../../src/core/contextual-retrieval-service.ts');
  // The importer's sealed state: current text projection, safe-chunk chunker, title-tier contextual retrieval.
  await sql.unsafe("UPDATE pages SET text_projection_revision = knowledge_revision, chunker_version = 4, contextual_retrieval_mode = 'title', corpus_generation = $1, embedding_signature = $2, source_path = slug || '.md'", [titleTierCorpusGeneration(), model + ':1536']);
  log('pages loaded');

  // Chunks: drop chunk-table secondary indexes, load, rebuild with the exact definitions.
  const idx = await sql.unsafe("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'content_chunks' AND indexname NOT IN ('content_chunks_pkey', 'idx_chunks_page_index')") as Array<{ indexname: string; indexdef: string }>;
  for (const i of idx) await sql.unsafe('DROP INDEX ' + i.indexname);
  const basis = buildBasis(params);
  await loadLatentCorpus({ params, plan, basis, queries: [], url, model, workers, log });
  await sql.unsafe("UPDATE content_chunks c SET embedded_at = now(), embedding_pending_since = NULL, projected_byte_start = strpos(p.compiled_truth, c.chunk_text) - 1, projected_byte_end = strpos(p.compiled_truth, c.chunk_text) - 1 + octet_length(c.chunk_text) FROM pages p WHERE p.id = c.page_id");
  log('chunks loaded; rebuilding ' + idx.length + ' indexes');
  await sql.unsafe("SET maintenance_work_mem = '" + (flag('--maintenance-mem', '4GB')) + "'");
  await sql.unsafe('SET max_parallel_maintenance_workers = ' + Math.max(1, workers - 1));
  for (const i of idx) { const s = performance.now(); await sql.unsafe(i.indexdef); log('  ' + i.indexname + ' ' + ((performance.now() - s) / 1000).toFixed(1) + 's'); }

  // Graph and timeline rows.
  await sql.unsafe("INSERT INTO links (from_page_id, to_page_id, link_type, link_source) SELECT g, 1 + ((g::bigint * 7919 + k * 104729) % $1), 'mentions', 'markdown' FROM generate_series(1, $1) g, generate_series(1, 3) k WHERE 1 + ((g::bigint * 7919 + k * 104729) % $1) <> g ON CONFLICT DO NOTHING", [plan.count]);
  await sql.unsafe("INSERT INTO timeline_entries (page_id, date, source, summary) SELECT id, effective_date::date, 'bench', title || ' follow-up' FROM pages WHERE type IN ('meeting', 'person') ON CONFLICT DO NOTHING");
  await sql.unsafe("UPDATE pages SET links_extracted_at = now()");
  await sql.unsafe('VACUUM ANALYZE');
  const [counts] = await sql.unsafe("SELECT (SELECT count(*) FROM pages)::int AS pages, (SELECT count(*) FROM content_chunks)::int AS chunks, (SELECT count(*) FROM links)::int AS links, (SELECT count(*) - count(DISTINCT slug) FROM pages)::int AS twin_slugs, pg_database_size(current_database())::bigint AS bytes") as any;
  await sql.end();
  const manifest = { db: dbName, seed, model, dims: 1536, sources: SOURCES, shares: SHARES, twin_share: TWIN_SHARE, ...counts, bytes: Number(counts.bytes), build_s: Math.round((performance.now() - t0) / 1000) };
  log(JSON.stringify(manifest));
  if (out) writeFileSync(out, JSON.stringify(manifest, null, 2));
}

if (import.meta.main) await main();
