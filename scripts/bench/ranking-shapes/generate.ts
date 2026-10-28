#!/usr/bin/env bun
/**
 * Synthetic ranking-shape corpus generator (GBRA-154 retrieval ranking wave).
 *
 * Writes test/fixtures/ranking-shapes/{source-a,source-b}/**.md plus
 * questions.jsonl. Everything is fictional: names come from seeded syllable
 * pools in this file, prose comes from an LLM that is told to invent
 * everything, and a final privacy pass rejects a deny-list of real-world names.
 *
 * Failure shapes planted (see run.ts for how each is scored):
 *   E1 twins, E2 redirect stubs, E3 document families, E4 org-vs-founder,
 *   E9 OCR image pages, E11 temporal, E13 very long pages, E15 paraphrased
 *   known-item questions. (E12 is a property of any result list.)
 *
 * Usage:
 *   OPENAI_API_KEY=... bun scripts/bench/ranking-shapes/generate.ts \
 *     [--out test/fixtures/ranking-shapes] [--model gpt-4.1-mini] [--seed 154] \
 *     [--cache-dir scripts/bench/ranking-shapes/.cache/llm] [--concurrency 8] [--plan-only]
 *
 * Every LLM response is cached on disk by prompt hash, so a rerun with the same
 * seed and prompts is free and byte-identical. Delete the cache dir to
 * regenerate the prose.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../../..');

// ---------------------------------------------------------------- CLI

function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) o[key] = true;
    else { o[key] = next; i++; }
  }
  return o;
}
const args = parseArgs(process.argv.slice(2));
const OUT = resolve(ROOT, String(args.out ?? 'test/fixtures/ranking-shapes'));
const CACHE = resolve(ROOT, String(args['cache-dir'] ?? 'scripts/bench/ranking-shapes/.cache/llm'));
const MODEL = String(args.model ?? 'gpt-4.1-mini');
const SEED = Number(args.seed ?? 154);
const CONCURRENCY = Number(args.concurrency ?? 8);
const PLAN_ONLY = args['plan-only'] === true;

// ---------------------------------------------------------------- RNG + names

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
function shuffle<T>(xs: T[]): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}
const FIRST = ['Marlow', 'Tamsin', 'Oriel', 'Bram', 'Ysolde', 'Corvin', 'Linnea', 'Fenwick', 'Odalys', 'Perrin', 'Ilsabet', 'Torben', 'Sorrel', 'Anwen', 'Casimir', 'Dorrit', 'Eilis', 'Hollis', 'Jorund', 'Kestrel', 'Lisbet', 'Merrin', 'Nadezhda', 'Orsin', 'Petra', 'Quillan', 'Rhosyn', 'Seren', 'Tobiah', 'Ulrika', 'Veda', 'Wystan', 'Xanthe', 'Yorick', 'Zephyra', 'Amadeo', 'Briony', 'Caspian', 'Delphine', 'Emrys', 'Fiora', 'Gideon', 'Halvard', 'Isolde', 'Jessamy', 'Kalev', 'Lorcan', 'Mirela', 'Niamh', 'Osric', 'Pavla', 'Rune', 'Saskia', 'Teodor', 'Una', 'Valdis', 'Winnow', 'Yvaine', 'Zosia', 'Alaric'];
const SUR_A = ['Brin', 'Talv', 'Ostr', 'Velk', 'Marq', 'Quen', 'Holm', 'Fenn', 'Dunk', 'Kesp', 'Lorn', 'Pelt', 'Ravn', 'Silv', 'Thrum', 'Wenk', 'Yarl', 'Zelk', 'Corv', 'Ibb', 'Jorv', 'Nask', 'Ulm', 'Vask', 'Gwil', 'Hesk'];
const SUR_B = ['wick', 'ford', 'mere', 'dale', 'ton', 'hollow', 'brook', 'stead', 'vane', 'croft', 'ley', 'ham', 'moor', 'by'];
const CO_A = ['Kel', 'Vor', 'Bri', 'Tess', 'Nuv', 'Par', 'Quil', 'Hal', 'Dor', 'Emb', 'Fyn', 'Glim', 'Jor', 'Lum', 'Mir', 'Nex', 'Orb', 'Pyr', 'Rin', 'Sol', 'Tav', 'Umb', 'Vex', 'Wyn', 'Xan', 'Zor', 'Aly', 'Cav', 'Dra', 'Eph'];
const CO_B = ['ora', 'ley', 'ix', 'aly', 'ik', 'ow', 'yra', 'vane', 'rel', 'dra', 'let', 'mere', 'tun', 'ova'];
const CO_SUFFIX = ['Systems', 'Labs', 'Works', 'Analytics', 'Robotics', 'Health', 'Freight', 'Cloud', 'Grid', 'Dynamics', 'Networks', 'Studio'];

const usedNames = new Set<string>();
const usedSurnames = new Set<string>();
function uniq(make: () => string): string {
  for (let i = 0; i < 2000; i++) {
    const n = make();
    if (!usedNames.has(n.toLowerCase())) { usedNames.add(n.toLowerCase()); return n; }
  }
  throw new Error('name pool exhausted');
}
// Surnames are unique across people so a "<first> <last>" query has one true owner.
const personName = () => uniq(() => {
  for (;;) {
    const sur = `${pick(SUR_A)}${pick(SUR_B)}`;
    if (usedSurnames.has(sur)) continue;
    usedSurnames.add(sur);
    return `${pick(FIRST)} ${sur}`;
  }
});
const companyName = () => uniq(() => `${pick(CO_A)}${pick(CO_B)} ${pick(CO_SUFFIX)}`);

const slugify = (s: string, max = 64) => {
  const base = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (base.length <= max) return base;
  const cut = base.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf('-'), 20));
};
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

// ---------------------------------------------------------------- LLM

const PRICE_IN = 0.4 / 1e6;
const PRICE_OUT = 1.6 / 1e6;
const usage = { calls: 0, cached: 0, inTok: 0, outTok: 0 };

interface ChatReq { system: string; user: string; json?: boolean; temperature?: number; maxTokens?: number; salt?: string }

async function chat(req: ChatReq): Promise<string> {
  const temperature = req.temperature ?? 0.8;
  const key = createHash('sha256').update(JSON.stringify([MODEL, req.system, req.user, temperature, !!req.json, req.salt ?? ''])).digest('hex');
  const file = join(CACHE, key.slice(0, 2), `${key}.json`);
  if (existsSync(file)) {
    usage.cached++;
    return JSON.parse(readFileSync(file, 'utf8')).text as string;
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is required for uncached generation');
  let lastErr = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: MODEL,
        temperature,
        max_tokens: req.maxTokens ?? 2500,
        ...(req.json ? { response_format: { type: 'json_object' } } : {}),
        messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
      }),
    });
    if (res.status === 429 || res.status >= 500) {
      lastErr = `${res.status} ${await res.text()}`;
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error('openai ' + res.status + ': ' + await res.text());
    const j = await res.json() as { choices: Array<{ message: { content: string } }>; usage?: { prompt_tokens: number; completion_tokens: number } };
    const text = j.choices[0]!.message.content;
    usage.calls++;
    usage.inTok += j.usage?.prompt_tokens ?? 0;
    usage.outTok += j.usage?.completion_tokens ?? 0;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ text, model: MODEL }));
    return text;
  }
  throw new Error('openai failed after retries: ' + lastErr);
}

async function chatJson<T>(req: ChatReq, validate: (v: any) => string | null): Promise<T> {
  let err = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const user = attempt ? req.user + '\n\nYour previous answer was rejected: ' + err + '. Fix that.' : req.user;
    const text = await chat({ ...req, json: true, salt: (req.salt ?? '') + '#' + attempt, user });
    try {
      const v = JSON.parse(text);
      const bad = validate(v);
      if (!bad) return v as T;
      err = bad;
    } catch (e) { err = 'invalid JSON (' + (e as Error).message + ')'; }
  }
  throw new Error('LLM JSON validation failed: ' + err);
}

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  }));
  return out;
}

// ---------------------------------------------------------------- Types

type PType = 'person' | 'company' | 'meeting' | 'note' | 'concept' | 'media' | 'writing';
type Role = 'plain' | 'E2' | 'E3' | 'E4' | 'E9' | 'E11' | 'E13';
interface Page { source: 'a' | 'b'; slug: string; type: string; title: string; fm: Record<string, unknown>; body: string }
interface Related { source_id: string; slug: string; role: string }
interface Row { id: string; shape: string; question: string; target: { source_id: string; slug: string }; also_ok: Array<{ source_id: string; slug: string }>; related: Related[]; notes: string }
interface Item {
  kind: 'target' | 'distractor';
  type: PType;
  role: Role;
  domain: number;
  name: string;
  planner?: Record<string, any>;
  slug?: string;
  title?: string;
  words: number;
  twin?: 'identical' | 'divergent';
  bOnly?: boolean;
}

const DOMAINS = [
  'cold-chain pharmaceutical logistics (temperature-controlled shipping, vaccine distribution, sensor tags)',
  'vertical farming and indoor agriculture (grow towers, nutrient dosing, yield forecasting)',
  'grid-scale battery storage (dispatch software, degradation modeling, interconnection queues)',
  'legal contract automation (clause extraction, redlining, procurement review)',
  'dental clinic scheduling and billing (chair utilization, insurance claims, recall campaigns)',
  'satellite imagery analytics for insurers (roof condition scoring, flood extent, catastrophe response)',
  'construction site robotics (rebar tying, drone surveys, safety monitoring)',
  'maritime port operations (berth scheduling, crane telemetry, customs clearance, container tracking)',
  'adaptive tutoring for K-12 schools (mastery tracking, teacher dashboards, district procurement)',
  'wildfire detection and utility vegetation management (camera networks, line inspection, outage risk)',
];

// Deny-list for the privacy pass (word-boundary, case-insensitive).
const REAL_DENY = [
  'openai', 'anthropic', 'google', 'microsoft', 'amazon', 'apple inc', 'tesla', 'nvidia', 'meta platforms', 'facebook', 'twitter', 'uber', 'airbnb', 'spacex', 'netflix', 'spotify', 'linkedin', 'salesforce', 'ibm', 'samsung', 'boeing', 'walmart', 'fedex', 'maersk', 'siemens', 'palantir', 'sequoia', 'andreessen', 'a16z', 'elon', 'musk', 'zuckerberg', 'bezos', 'altman', 'nadella', 'pichai', 'buffett', 'obama', 'trump', 'biden', 'rogan', 'ferriss', 'fridman', 'huberman', 'chatgpt', 'iphone', 'kubernetes', 'aws', 'pfizer', 'moderna', 'johnson & johnson', 'unitedhealth', 'dhl', 'tiktok', 'youtube', 'coursera', 'khan academy', 'duolingo',
];

// ---------------------------------------------------------------- Plan

function buildItems(): Item[] {
  const items: Item[] = [];
  const targetPlan: Array<[PType, Role[]]> = [
    ['person', ['E9', 'E9', 'E9', 'E9', 'E2', 'E2', 'plain', 'plain', 'plain', 'plain']],
    ['company', ['E4', 'E4', 'E4', 'E4', 'E4', 'E4', 'E2', 'E2']],
    ['meeting', ['E11', 'E11', 'E11', 'E11', 'E13', 'E13', 'plain', 'plain']],
    ['note', ['E3', 'E3', 'E3', 'E3', 'plain', 'plain', 'plain', 'plain']],
    ['concept', ['E2', 'E2', 'plain', 'plain', 'plain', 'plain', 'plain', 'plain']],
    ['media', ['plain', 'plain', 'plain', 'plain']],
    ['writing', ['plain', 'plain', 'plain', 'plain']],
  ];
  const distractorPlan: Array<[PType, number]> = [['person', 18], ['company', 16], ['meeting', 16], ['note', 14], ['concept', 20], ['media', 8], ['writing', 8]];
  const wordsFor = (type: PType, kind: 'target' | 'distractor', role: Role) => {
    if (role === 'E13') return 0;
    const t = { person: [300, 450], company: [200, 300], meeting: [280, 450], note: [200, 350], concept: [200, 350], media: [380, 500], writing: [380, 500] }[type];
    const d = { person: [130, 220], company: [110, 200], meeting: [130, 230], note: [110, 200], concept: [110, 200], media: [150, 260], writing: [150, 260] }[type];
    const [lo, hi] = kind === 'target' ? t : d;
    return lo + Math.floor(rnd() * (hi - lo));
  };
  let off = 0;
  for (const [type, roles] of targetPlan) {
    roles.forEach((role, i) => {
      items.push({ kind: 'target', type, role, domain: (off + i) % DOMAINS.length, name: '', words: wordsFor(type, 'target', role) });
    });
    off += 3;
  }
  for (const [type, n] of distractorPlan) {
    for (let i = 0; i < n; i++) items.push({ kind: 'distractor', type, role: 'plain', domain: (off + i) % DOMAINS.length, name: '', words: wordsFor(type, 'distractor', 'plain') });
    off += 3;
  }
  // E1 twins: 15 plain targets + 5 distractors; every fourth one is divergent (different type, shorter body).
  const plainTargets = shuffle(items.filter(i => i.kind === 'target' && i.role === 'plain'));
  const twinDistractors = shuffle(items.filter(i => i.kind === 'distractor')).slice(0, 5);
  const twins = shuffle([...plainTargets.slice(0, 15), ...twinDistractors]);
  twins.forEach((it, i) => { it.twin = i % 4 === 3 ? 'divergent' : 'identical'; });
  shuffle(items.filter(i => i.kind === 'distractor' && !i.twin)).slice(0, 10).forEach(i => { i.bOnly = true; });
  return items;
}

// ---------------------------------------------------------------- Planner

interface DomainPlan { people: any[]; companies: any[]; meetings: any[]; notes: any[]; concepts: any[]; media: any[]; writing: any[] }
const KEY_OF: Record<PType, keyof DomainPlan> = { person: 'people', company: 'companies', meeting: 'meetings', note: 'notes', concept: 'concepts', media: 'media', writing: 'writing' };

async function planDomain(d: number, counts: Record<keyof DomainPlan, number>): Promise<DomainPlan> {
  const system = 'You design fictional corpora for a search-ranking benchmark. Everything must be invented. Never mention real people, companies, funds, podcasts, products or places. Output a single JSON object.';
  const user = `Domain: ${DOMAINS[d]}

Invent the raw material for a fictional internal wiki about this domain. Return JSON with exactly these arrays and exact lengths:
- "people": ${counts.people} items {"role": job title, "specialty": 5-10 words, "history_hook": one concrete career detail}
- "companies": ${counts.companies} items {"product_name": invented product name (1-2 words), "pitch": one sentence on what the product does, "customer_industry": the customers' industry in 2-4 words, "traction": one concrete invented metric}
- "meetings": ${counts.meetings} items {"title": 3-7 words, "summary": one sentence, "activity": a 3-6 word noun phrase naming a project or pilot that the meeting kicked off (for example "the pallet-tracking pilot")}
- "notes": ${counts.notes} items {"title": 3-7 words, "summary": one sentence}
- "concepts": ${counts.concepts} items {"title": 2-5 words, "summary": one sentence definition}
- "media": ${counts.media} items {"title": 3-7 words (a talk or episode title), "show": invented show name, "summary": one sentence}
- "writing": ${counts.writing} items {"title": 3-7 words (essay title), "summary": one sentence}
Rules: every title is distinct and specific; items overlap in vocabulary and jargon on purpose (similar industries, similar meetings, overlapping roles) so a search engine has to work to separate them; do not repeat a title word more than 3 times across the whole output; no dates in titles; no real-world brand names.`;
  const lens = (v: any) => {
    for (const k of Object.keys(counts) as Array<keyof DomainPlan>) {
      if (!Array.isArray(v[k]) || v[k].length !== counts[k]) return '"' + k + '" must have exactly ' + counts[k] + ' items';
    }
    return null;
  };
  return chatJson<DomainPlan>({ system, user, temperature: 0.9, maxTokens: 4000, salt: 'plan-' + d }, lens);
}

// ---------------------------------------------------------------- Writers

const SYS_WRITER = 'You write pages of a fictional internal wiki for a search-ranking benchmark. Everything is invented: never mention real people, real companies, real products, real shows or real places. Write plain markdown prose (short paragraphs, a few bullets or sub-headings are fine). Do NOT output a top-level title heading or YAML frontmatter; the caller adds them. Name no person except those the prompt supplies (refer to anyone else by role, such as the CFO or a customer), and no real agencies, brands or funds. Be concrete: include specific invented numbers, names of projects, places and decisions so the page is distinctive.';

async function write(prompt: string, words: number, salt: string): Promise<string> {
  let best = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = (await chat({ system: SYS_WRITER, user: prompt + '\n\nLength: about ' + words + ' words.', temperature: 0.8, maxTokens: Math.ceil(words * 2.2) + 200, salt: salt + '#' + attempt })).trim();
    if (wordCount(text) >= words * 0.6) return text;
    if (wordCount(text) > wordCount(best)) best = text;
  }
  return best;
}

const TYPE_GUIDE: Record<PType, string> = {
  person: 'a person page: current role and employer, career history with years, specialties, notable projects with invented codenames, working style, who they work with. Third person.',
  company: 'a company page: what the product does and for whom, customers, stage and invented funding/traction, team, competitors (invented), open risks.',
  meeting: 'meeting notes: start with "Date:" and "Attendees:" lines, then agenda, discussion with specific numbers, decisions and action items with owners.',
  note: 'a working note by a team member: observations, measurements, open questions, next steps. Informal but specific.',
  concept: 'a concept explainer: definition, how it works, tradeoffs, a worked example with numbers, common failure modes.',
  media: 'a transcript excerpt of a talk or podcast episode (invented show and speakers): speaker-labelled lines, natural spoken language, specific anecdotes.',
  writing: 'an original essay or blog post draft by an invented author: a clear argument, an anecdote, a concrete recommendation.',
};

const DIRS: Record<PType, string> = { person: 'people', company: 'companies', meeting: 'meetings', note: 'notes', concept: 'concepts', media: 'media', writing: 'writing' };

function randDate(y0 = 2023, y1 = 2025): string {
  const y = y0 + Math.floor(rnd() * (y1 - y0 + 1));
  const m = 1 + Math.floor(rnd() * 12);
  const d = 1 + Math.floor(rnd() * 27);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ---------------------------------------------------------------- Question helpers

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'into', 'over', 'about', 'that', 'this', 'what', 'when', 'who', 'how', 'why', 'does', 'did', 'was', 'are', 'its', 'our', 'their', 'old', 'summary']);
const stem = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(ing|ed|es|s)$/, '');
function titleTokens(...titles: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of titles) for (const w of t.split(/[^A-Za-z0-9]+/)) if (w.length >= 3 && !STOP.has(w.toLowerCase())) out.add(stem(w));
  return out;
}
function overlap(q: string, forbidden: Set<string>): string[] {
  const hits: string[] = [];
  for (const w of q.split(/[^A-Za-z0-9]+/)) if (w.length >= 3 && forbidden.has(stem(w))) hits.push(w);
  return [...new Set(hits)];
}

async function askQuestion(instructions: string, forbidden: Set<string>, validate: ((q: string) => string | null) | null, salt: string): Promise<{ q: string; note: string }> {
  let feedback = '';
  let last = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const text = await chat({
      system: 'You write search queries for a retrieval benchmark. Output a single JSON object {"question": "..."}.',
      user: instructions + (feedback ? '\n\nYour previous attempt "' + last + '" was rejected: ' + feedback : ''),
      json: true,
      temperature: 0.9,
      maxTokens: 200,
      salt: salt + '#' + attempt,
    });
    let q = '';
    try { q = String(JSON.parse(text).question ?? '').trim(); } catch { /* retry */ }
    last = q;
    if (!q) { feedback = 'empty or invalid JSON'; continue; }
    const hits = overlap(q, forbidden);
    if (hits.length) { feedback = 'it reuses forbidden words: ' + hits.join(', ') + '. Rephrase without them.'; continue; }
    const bad = validate?.(q);
    if (bad) { feedback = bad; continue; }
    return { q, note: '' };
  }
  const hits = overlap(last, forbidden);
  return { q: last, note: hits.length ? 'WARNING question still overlaps title words: ' + hits.join(',') : 'WARNING validation failed after retries' };
}

// ---------------------------------------------------------------- Main generation

const pages: Page[] = [];
const rows: Row[] = [];
const manifest: Array<{ source: string; slug: string; type: string; role: string }> = [];
const addPage = (p: Page, role: string) => { pages.push(p); manifest.push({ source: 'source-' + p.source, slug: p.slug, type: p.type, role }); };

const items = buildItems();
console.error('[plan] ' + items.length + ' base items (' + items.filter(i => i.kind === 'target').length + ' targets)');

// Names first (seeded, deterministic), so cross-references are known before any LLM call.
for (const it of items) it.name = it.type === 'person' ? personName() : it.type === 'company' ? companyName() : '';
const founders = new Map<Item, { name: string; slug?: string }>();
for (const it of items) if (it.role === 'E4') founders.set(it, { name: personName() });

const perDomain: DomainPlan[] = [];
await pool(DOMAINS.map((_, d) => d), CONCURRENCY, async d => {
  const mine = items.filter(i => i.domain === d);
  const counts = { people: 0, companies: 0, meetings: 0, notes: 0, concepts: 0, media: 0, writing: 0 } as Record<keyof DomainPlan, number>;
  for (const i of mine) counts[KEY_OF[i.type]]++;
  perDomain[d] = await planDomain(d, counts);
});
const cursor = DOMAINS.map(() => ({ people: 0, companies: 0, meetings: 0, notes: 0, concepts: 0, media: 0, writing: 0 }) as Record<keyof DomainPlan, number>);
for (const it of items) {
  const k = KEY_OF[it.type];
  it.planner = perDomain[it.domain]![k][cursor[it.domain]![k]++];
  if (it.type === 'person' || it.type === 'company') it.title = it.name;
  else it.title = String(it.planner!.title).replace(/["\n]/g, '').trim();
  const dir = DIRS[it.type];
  if (it.type === 'meeting') {
    it.planner!.date = randDate();
    it.slug = `${dir}/${it.planner!.date}-${slugify(it.title!, 48)}`;
  } else if (it.type === 'person') it.slug = `${dir}/${slugify(it.name)}`;
  else it.slug = `${dir}/${slugify(it.title!)}`;
}
const seenSlugs = new Set<string>();
for (const it of items) {
  let s = it.slug!, n = 2;
  while (seenSlugs.has(s)) s = `${it.slug}-${n++}`;
  it.slug = s; seenSlugs.add(s);
}
if (PLAN_ONLY) {
  for (const it of items) console.log([it.kind, it.type, it.role, 'd' + it.domain, it.slug, it.twin ?? '', it.bOnly ? 'b-only' : ''].join('\t'));
  process.exit(0);
}

for (const it of items) {
  const pl = it.planner!;
  if (it.type === 'meeting') pl.attendees = shuffle(items.filter(i => i.type === 'person' && i.domain === it.domain)).slice(0, 3 + Math.floor(rnd() * 2)).map(a => a.slug);
  if (it.type === 'media') {
    pl.speakers = [personName(), personName()];
    pl.show = 'The ' + pick(CO_A) + pick(CO_B) + ' ' + pick(['Hour', 'Review', 'Sessions', 'Dispatch', 'Briefing']);
  }
  if (it.role === 'E3') pl.talkSpeaker = personName();
  if (it.role === 'E13') pl.sectionPick = 4 + Math.floor(rnd() * 4);
}

const peopleByDomain = (d: number) => items.filter(i => i.type === 'person' && i.domain === d);
const companiesByDomain = (d: number) => items.filter(i => i.type === 'company' && i.domain === d);
const bodiesBySlug = new Map<string, string>();

async function writeLongMeeting(it: Item, attendees: Item[]): Promise<string> {
  const pl = it.planner!;
  const names = attendees.map(a => a.name).join(', ');
  const outline = await chatJson<{ sections: Array<{ heading: string; focus: string }> }>({
    system: 'You outline fictional meeting notes. Output JSON.',
    user: 'Domain: ' + DOMAINS[it.domain] + '. Meeting: ' + it.title + ' (' + pl.summary + '). Attendees: ' + names + '. Return {"sections":[{"heading": "...", "focus": "one sentence of what is discussed, including one invented codename or number"}]} with exactly 8 sections for a long quarterly review.',
    temperature: 0.9, maxTokens: 1800, salt: 'outline-' + it.slug,
  }, v => (Array.isArray(v.sections) && v.sections.length === 8 ? null : 'sections must have exactly 8 items'));
  const head = 'Date: ' + pl.date + '\n\nAttendees: ' + names + '\n\nAttendee pages: ' + attendees.map(a => '[[' + a.slug + ']]').join(', ');
  const sections = await pool(outline.sections, 5, async (s, i) => {
    let text = '';
    for (let a = 0; a < 3 && text.length < 4300; a++) {
      text = (await chat({
        system: SYS_WRITER,
        user: 'This is section ' + (i + 1) + ' of a long, detailed fictional meeting record titled "' + it.title + '" in the domain ' + DOMAINS[it.domain] + '.\nSection heading: ' + s.heading + '. Focus: ' + s.focus + '.\nAttendees (use only these names, as speakers): ' + names + '.\nWrite roughly 5000 characters (about 800 words) of detailed back-and-forth discussion with specific figures, quotes and decisions. No heading line.',
        temperature: 0.85, maxTokens: 2200, salt: it.slug + '-sec' + i + '#' + a,
      })).trim();
    }
    return '## ' + s.heading + '\n\n' + text;
  });
  return [head, ...sections].join('\n\n');
}

async function buildItem(it: Item): Promise<void> {
  const d = it.domain;
  const dom = DOMAINS[d]!;
  const pl = it.planner!;
  const base = 'Domain: ' + dom + '.\nTitle: ' + it.title + '\nWrite ' + TYPE_GUIDE[it.type];
  let body = '';
  const fm: Record<string, unknown> = { type: it.type, title: it.title, tags: [slugify(dom.split(' (')[0]!, 40)] };

  if (it.type === 'person') {
    const employer = companiesByDomain(d)[0];
    body = await write(base + '\nRole: ' + pl.role + '. Specialty: ' + pl.specialty + '. Career detail to weave in: ' + pl.history_hook + '.' + (employer ? ' Employer: ' + employer.name + ' (' + employer.planner!.pitch + ').' : '') + ' The person is named ' + it.name + '.', it.words, it.slug!);
    if (employer) body += '\n\nCurrent employer: [[' + employer.slug + ']].';
  } else if (it.type === 'company') {
    body = await write(base + '\nProduct: ' + pl.product_name + ', ' + pl.pitch + ' Customers: ' + pl.customer_industry + '. Traction: ' + pl.traction + '. The company is named ' + it.name + '.', it.words, it.slug!);
    const founder = founders.get(it);
    if (founder) body += '\n\nFounder: [[people/' + slugify(founder.name) + ']].';
  } else if (it.type === 'meeting') {
    const attendees = (pl.attendees as string[]).map(sl => items.find(i => i.slug === sl)!);
    fm.date = pl.date;
    fm.attendees = attendees.map(a => a.name);
    if (it.role === 'E13') body = await writeLongMeeting(it, attendees);
    else {
      const e11 = it.role === 'E11'
        ? '\nThis is the kickoff meeting at which ' + pl.activity + ' officially started. State plainly, in the discussion, that ' + pl.activity + ' started on ' + pl.date + ' (the meeting date), and who owns it.'
        : '';
      body = await write(base + '\nDate: ' + pl.date + '. Attendees: ' + attendees.map(a => a.name).join(', ') + '. Meeting subject: ' + pl.summary + e11, it.words, it.slug!);
      body += '\n\nAttendee pages: ' + attendees.map(a => '[[' + a.slug + ']]').join(', ') + '.';
    }
  } else if (it.type === 'media') {
    fm.source_kind = 'transcript';
    fm.show = pl.show;
    body = await write(base + '\nShow: ' + pl.show + '. Episode/talk: ' + pl.title + '. Summary: ' + pl.summary + '\nThe only people named are the host ' + pl.speakers[0] + ' and the guest ' + pl.speakers[1] + '; audience members are unnamed.', it.words, it.slug!);
  } else {
    body = await write(base + '\nSubject: ' + pl.summary, it.words, it.slug!);
  }
  bodiesBySlug.set(it.slug!, body);
  addPage({ source: 'a', slug: it.slug!, type: it.type, title: it.title!, fm, body: '# ' + it.title + '\n\n' + body + '\n' }, it.kind + ':' + it.role);
}

// ---------------------------------------------------------------- Special cases

async function buildFounder(company: Item): Promise<void> {
  const f = founders.get(company)!;
  const pl = company.planner!;
  const slug = 'people/' + slugify(f.name);
  const body = await write(
    'Domain: ' + DOMAINS[company.domain] + '.\nWrite a person page for ' + f.name + ', founder and CEO of ' + company.name + '. This page is long and densely about the product: mention the product "' + pl.product_name + '" by name at least eight times and describe in detail what it does (' + pl.pitch + ') for ' + pl.customer_industry + ', how ' + f.name + ' came up with it, early customers, pricing experiments and roadmap. Third person, with a career history and years.',
    420, slug,
  );
  f.slug = slug;
  addPage({ source: 'a', slug, type: 'person', title: f.name, fm: { type: 'person', title: f.name, tags: [slugify(DOMAINS[company.domain]!.split(' (')[0]!, 40)] }, body: '# ' + f.name + '\n\n' + body + '\n\nFounder of [[' + company.slug + ']].\n' }, 'founder');
}

function stubFor(it: Item, n: number): Page {
  const t = it.type;
  const fm: Record<string, unknown> = { type: t };
  let slug: string, title: string;
  if (t === 'person') { slug = it.slug + '-1'; title = it.title!; }
  else if (t === 'company') { slug = it.slug + '-old'; title = it.title!; }
  else { slug = it.slug + '-old'; title = it.title + ' (old)'; }
  fm.title = title;
  if (n % 2 === 0) fm.merged_into = it.slug;
  return { source: 'a', slug, type: t, title, fm, body: '# ' + title + '\n\nThis page has been merged into [[' + it.slug + ']]\n' };
}

async function buildE3Family(it: Item): Promise<{ transcript: Page; summary: Page; copy: Page }> {
  const pl = it.planner!;
  const speaker = pl.talkSpeaker as string;
  const talkTitle = pl.title + ': lessons from the field';
  const talkSlug = 'media/' + slugify(talkTitle);
  const transcriptBody = await write(
    'Domain: ' + DOMAINS[it.domain] + '.\nWrite a verbatim, speaker-labelled transcript of a conference talk by ' + speaker + ' on the same subject as an internal note titled "' + it.title + '" (' + pl.summary + '). Reuse much of the same vocabulary as that subject. Include audience Q&A fragments. The talk is called "' + talkTitle + '". The speaker is the only person named; the moderator is just "Moderator" and audience members are unnamed.',
    520, talkSlug,
  );
  const summaryBody = await write(
    'Summarise the following talk transcript in a neutral third-person summary with five bullet points and a one-paragraph overview. Keep the subject vocabulary.\n\n' + transcriptBody,
    170, talkSlug + '-summary',
  );
  const mk = (slug: string, type: string, title: string, body: string, extra: Record<string, unknown> = {}): Page => ({ source: 'a', slug, type, title, fm: { type, title, ...extra }, body: '# ' + title + '\n\n' + body + '\n' });
  return {
    transcript: mk(talkSlug, 'media', talkTitle, transcriptBody, { source_kind: 'transcript' }),
    summary: mk(talkSlug + '-summary', 'media', talkTitle + ' (summary)', summaryBody, { source_kind: 'summary' }),
    copy: mk('concepts/' + slugify(talkTitle), 'concept', talkTitle, transcriptBody),
  };
}

async function buildE11Stub(it: Item): Promise<Page> {
  const pl = it.planner!;
  const act = String(pl.activity).replace(/^the /i, '');
  const title = act.charAt(0).toUpperCase() + act.slice(1) + ' overview';
  const body = await write(
    'Domain: ' + DOMAINS[it.domain] + '.\nWrite a short undated concept stub about ' + pl.activity + ': what it is, why it matters, the vocabulary used for it, who typically owns it. Do NOT include any dates, years, months or "started/began/kicked off" statements.',
    80, 'e11stub-' + it.slug,
  );
  const slug = 'concepts/' + slugify(title);
  return { source: 'a', slug, type: 'concept', title, fm: { type: 'concept', title }, body: '# ' + title + '\n\n' + body + '\n' };
}

// Each image page shares exactly one word with the "<first> <last>" query.
function imagePagesFor(it: Item, others: string[], used: Set<string>): Page[] {
  const [first, last] = it.name.split(' ') as [string, string];
  const other = (): [string, string] => {
    for (;;) {
      const [f, l] = pick(others).split(' ') as [string, string];
      if (f !== first && l !== last) return [f, l];
    }
  };
  const [of1, ol1] = other();
  const [of2] = other();
  const [of3, ol3] = other();
  const texts = [
    'BADGE\n' + first + ' ' + ol1 + '\nVisitor - Hall B\nNo. ' + (1000 + Math.floor(rnd() * 8000)),
    of2 + ' ' + last + '\nWHITEBOARD: Q3 roadmap\nowner ' + of1,
    'Receipt - ' + first + "'s Corner Cafe\nFlat white 3.80\nTotal 18.40\nCashier " + of3 + ' ' + ol3,
  ].slice(0, 2 + Math.floor(rnd() * 2));
  return texts.map(text => {
    let slug: string;
    do slug = 'images/' + randDate(2024, 2025) + '-img-' + (1000 + Math.floor(rnd() * 9000)) + '.jpg'; while (used.has(slug));
    used.add(slug);
    const title = slug.split('/')[1]!;
    return { source: 'a', slug, type: 'image', title, fm: { type: 'image', title, ocr: true, source_kind: 'image' }, body: 'OCR text:\n' + text + '\n' };
  });
}

// ---- run units

const targets = items.filter(i => i.kind === 'target');
await pool(items, CONCURRENCY, buildItem);
console.error('[pages] base pages written: ' + pages.length);

await pool(items.filter(i => i.role === 'E4'), CONCURRENCY, buildFounder);

const familyByNote = new Map<Item, { transcript: Page; summary: Page; copy: Page }>();
await pool(targets.filter(i => i.role === 'E3'), CONCURRENCY, async it => {
  const fam = await buildE3Family(it);
  familyByNote.set(it, fam);
  for (const p of [fam.transcript, fam.summary, fam.copy]) addPage(p, 'E3-family');
});

const e11Stubs = new Map<Item, Page>();
await pool(targets.filter(i => i.role === 'E11'), CONCURRENCY, async it => {
  const s = await buildE11Stub(it);
  e11Stubs.set(it, s); addPage(s, 'E11-stub');
});

const imagesByPerson = new Map<Item, Page[]>();
{
  const used = new Set<string>();
  const others = items.filter(i => i.type === 'person' && i.role !== 'E9').map(i => i.name);
  for (const it of targets.filter(i => i.role === 'E9')) {
    const imgs = imagePagesFor(it, others, used);
    imagesByPerson.set(it, imgs);
    for (const p of imgs) addPage(p, 'E9-image');
  }
}

const e2Stubs = new Map<Item, Page>();
targets.filter(i => i.role === 'E2').forEach((it, n) => {
  const s = stubFor(it, n);
  e2Stubs.set(it, s); addPage(s, 'E2-stub');
});

// ---- twins / source-b

const DIVERGENT_TYPE: Record<string, string> = { person: 'note', meeting: 'note', note: 'concept', concept: 'note', media: 'concept', writing: 'note', company: 'note' };
const aBySlug = new Map(pages.filter(p => p.source === 'a').map(p => [p.slug, p]));
for (const it of items) {
  if (!it.twin && !it.bOnly) continue;
  const a = aBySlug.get(it.slug!)!;
  if (it.bOnly) {
    pages.splice(pages.indexOf(a), 1);
    manifest.splice(manifest.findIndex(m => m.slug === a.slug && m.source === 'source-a'), 1);
    addPage({ ...a, source: 'b' }, it.kind + ':b-only');
  } else if (it.twin === 'identical') {
    addPage({ ...a, source: 'b' }, 'twin-identical:' + it.kind);
  } else {
    const paras = a.body.split('\n\n');
    const keep = paras.slice(0, Math.max(2, Math.ceil(paras.length * 0.55))).join('\n\n');
    const type = DIVERGENT_TYPE[it.type]!;
    addPage({ source: 'b', slug: a.slug, type, title: a.title, fm: { ...a.fm, type }, body: keep + '\n\n(Condensed copy of the original page.)\n' }, 'twin-divergent:' + it.kind);
  }
}

// ---------------------------------------------------------------- Questions

const twinOf = (it: Item) => (it.twin ? [{ source_id: 'source-b', slug: it.slug! }] : []);
const qrows: Array<{ it: Item; shape: string; question: string; notes: string; related: Related[] }> = [];

function paraphraseInstr(it: Item, angle: string) {
  const body = aBySlug.get(it.slug!)!.body.slice(0, 3500);
  return 'Below is a wiki page. Write ONE natural question that someone who half-remembers this page might type into a search box, such that this page is the best answer. Paraphrase: describe the page\'s distinctive content in your own words instead of copying its title. Angle: ' + angle + '.\n\nTitle: ' + it.title + '\n\n' + body;
}

await pool(targets, CONCURRENCY, async it => {
  const title = it.title!;
  if (it.role === 'E9') {
    qrows.push({ it, shape: 'E9', question: it.name, notes: 'name query; each OCR image page shares exactly one query word', related: imagesByPerson.get(it)!.map(p => ({ source_id: 'source-a', slug: p.slug, role: 'image' })) });
  } else if (it.role === 'E2') {
    const s = e2Stubs.get(it)!;
    const q = it.type === 'person' ? 'Who is ' + title + '?' : it.type === 'company' ? 'What does ' + title + ' do?' : title + ' explained';
    qrows.push({ it, shape: 'E2', question: q, notes: 'redirect stub ' + s.slug + (s.fm.merged_into ? ' (has merged_into frontmatter)' : ' (body only)'), related: [{ source_id: 'source-a', slug: s.slug, role: 'stub' }] });
  } else if (it.role === 'E3') {
    const fam = familyByNote.get(it)!;
    const r = await askQuestion(
      'A team note titled "' + title + '" holds the answer to a question. A conference talk on the same subject (title: "' + fam.transcript.title + '") also exists in several copies. Write ONE natural question about the subject whose best answer is the team note (its conclusion or recommendation). Use the subject\'s own vocabulary (sharing words with the talk is fine), but do not name any person.\n\nNote:\n' + aBySlug.get(it.slug!)!.body.slice(0, 3000),
      new Set(), null, 'q-e3-' + it.slug);
    qrows.push({ it, shape: 'E3', question: r.q, notes: 'family of 3 derived pages on the same subject' + (r.note ? ' ' + r.note : ''), related: [fam.transcript, fam.summary, fam.copy].map(p => ({ source_id: 'source-a', slug: p.slug, role: 'family' })) });
  } else if (it.role === 'E4') {
    const f = founders.get(it)!;
    const pl = it.planner!;
    const forbid = titleTokens(title, f.name, String(pl.product_name));
    const r = await askQuestion(
      'Write ONE descriptive search query of the form "API/tool/platform that does X for Y industry" for the product below. Describe what it does and who it serves in your own words. Do NOT use the company name, the product name, any person\'s name, or these words: ' + [...forbid].join(', ') + '.\n\nProduct: ' + pl.product_name + ' - ' + pl.pitch + ' Customers: ' + pl.customer_industry + '.',
      forbid, null, 'q-e4-' + it.slug);
    qrows.push({ it, shape: 'E4', question: r.q, notes: 'company; founder page ' + f.slug + ' mentions the product heavily' + (r.note ? ' ' + r.note : ''), related: [{ source_id: 'source-a', slug: f.slug!, role: 'founder' }] });
  } else if (it.role === 'E11') {
    const stub = e11Stubs.get(it)!;
    const r = await askQuestion(
      'Write ONE question of exactly the form "when did <x> start <y>" where <y> refers to ' + it.planner!.activity + ' and <x> is the team or person who started it (invent a plausible short subject that fits the meeting, such as a team name; never the name of a person). Do not include a date.\n\nMeeting excerpt:\n' + aBySlug.get(it.slug!)!.body.slice(0, 1500),
      new Set(), q => (/^when did .+ start .+/i.test(q) ? null : 'must match "when did <x> start <y>"'), 'q-e11-' + it.slug);
    qrows.push({ it, shape: 'E11', question: r.q, notes: 'dated meeting ' + it.planner!.date + '; undated concept stub ' + stub.slug + (r.note ? ' ' + r.note : ''), related: [{ source_id: 'source-a', slug: stub.slug, role: 'undated-stub' }] });
  } else if (it.role === 'E13') {
    const body = aBySlug.get(it.slug!)!.body;
    const secs = body.split(/\n## /).slice(1);
    const sec = secs[it.planner!.sectionPick as number] ?? secs[0]!;
    const forbid = titleTokens(title);
    const r = await askQuestion(
      'Below is one section of a very long meeting record. Write ONE natural question about a specific detail in this section (a figure, decision, or codename) that a person could ask without knowing the meeting\'s title. Paraphrase; do not use these words: ' + [...forbid].join(', ') + '.\n\n' + sec.slice(0, 3500),
      forbid, null, 'q-e13-' + it.slug);
    qrows.push({ it, shape: 'E13', question: r.q, notes: 'very long page (' + body.length + ' chars)' + (r.note ? ' ' + r.note : ''), related: [] });
  } else {
    const forbid = titleTokens(title);
    const r = await askQuestion(paraphraseInstr(it, 'the main point or most distinctive fact') + '\n\nDo not use these words: ' + [...forbid].join(', ') + '.', forbid, null, 'q-base-' + it.slug);
    qrows.push({ it, shape: it.twin ? 'E1' : 'E15', question: r.q, notes: it.type + '; ' + (it.twin ? 'twin ' + it.twin + ' in source-b' : 'single source') + (r.note ? ' ' + r.note : ''), related: [] });
  }
});

// 20 extra paraphrases (a second, different angle) over random targets.
const baseQ = new Map(qrows.map(r => [r.it, r.question]));
const extraPool = shuffle(targets.filter(i => i.role !== 'E13' && i.role !== 'E9'));
await pool(extraPool.slice(0, 20), CONCURRENCY, async it => {
  const forbid = titleTokens(it.title!);
  const r = await askQuestion(paraphraseInstr(it, 'a detail from the second half of the page, phrased differently from this earlier question: ' + baseQ.get(it)) + '\n\nDo not use these words: ' + [...forbid].join(', ') + '.', forbid, null, 'q-extra-' + it.slug);
  qrows.push({ it, shape: it.twin ? 'E1' : 'E15', question: r.q, notes: 'second paraphrase of a ' + it.role + ' target' + (r.note ? ' ' + r.note : ''), related: [] });
});

qrows.sort((a, b) => (a.it.slug! + a.shape).localeCompare(b.it.slug! + b.shape) || a.question.localeCompare(b.question));
qrows.forEach((r, i) => {
  rows.push({ id: 'q' + String(i + 1).padStart(3, '0'), shape: r.shape, question: r.question, target: { source_id: 'source-a', slug: r.it.slug! }, also_ok: twinOf(r.it), related: r.related, notes: r.notes });
});

// ---------------------------------------------------------------- Scrub + privacy pass

// Safety net for real-sounding strings the model still produces despite the prompt rules.
const SCRUB: Array<[RegExp, string]> = [
  [/\bNorthwind\b/g, 'Northvale'], [/\bMeridian\b/g, 'Merrowick'], [/\bNimbus\b/g, 'Nimbrel'], [/\bHurricane Delta\b/g, 'Hurricane Delmora'],
  [/\bAWS\b/g, 'Skycloud'], [/\bFDA\b/g, 'NHRA'], [/\bDoD\b/g, 'MoD'], [/\(UPS\)/g, '(backup power)'], [/\bUPS\b/g, 'backup power'],
];
const scrubBase = (t: string) => SCRUB.reduce((a, [re, to]) => a.replace(re, to), t);
const REAL_FIRSTS = ['Maya', 'Elena', 'Jamal', 'Priya', 'Raj', 'Ravi', 'Jane', 'Carlos', 'Jordan', 'Jamie', 'Rohan', 'Lena', 'Greg', 'Mike', 'Mira', 'Kaitlyn', 'Leo', 'Samir', 'Jen', 'Alex', 'Sarah', 'John', 'David', 'Michael', 'James', 'Robert', 'Emily', 'Anna', 'Maria', 'Daniel', 'Kiran', 'Marina', 'Lianne', 'Linton', 'Chen', 'Patel', 'Rivera', 'Rodriguez', 'Torres', 'Moretti', 'Smith', 'Johnson', 'Williams', 'Garcia', 'Martinez', 'Lopez', 'Nguyen', 'Singh', 'Kumar', 'Sharma', 'Ahmed', 'Khan', 'Wang', 'Zhang', 'Liu', 'Choi', 'Nakamura', 'Tanaka', 'Sato', 'Suzuki', 'Muller', 'Schmidt', 'Fischer', 'Weber', 'Meyer', 'Dubois', 'Bernard', 'Rossi', 'Russo', 'Ferrari', 'Esposito', 'Bianchi', 'Romano', 'Okafor', 'Adeyemi', 'Mensah', 'Nasser', 'Cohen', 'Goldberg', 'Emma', 'Olivia', 'Liam', 'Noah', 'Sophia', 'Isabella', 'Ethan', 'Lucas', 'Amelia', 'Harper', 'Evelyn', 'Abigail', 'Ella', 'Priyanka', 'Anil', 'Amit', 'Neha', 'Sunita', 'Yuki', 'Hiro', 'Chloe', 'Ben', 'Tom', 'Tim', 'Bob', 'Bill', 'Steve', 'Kate', 'Lisa', 'Karen', 'Susan', 'Linda'];
const realFirstRe = new RegExp('(^|[^A-Za-z0-9_])(' + REAL_FIRSTS.join('|') + ')([^A-Za-z0-9]|$)');
// Any leaked common real name becomes a stable invented one (hash of the original).
const nameHash = (n: string) => parseInt(createHash('sha256').update(n).digest('hex').slice(0, 8), 16);
const inventedFor = (n: string) => CO_A[nameHash(n) % CO_A.length]! + CO_B[Math.floor(nameHash(n) / 31) % CO_B.length]!;
const realFirstAll = new RegExp('\\b(' + [...new Set(REAL_FIRSTS)].join('|') + ')\\b', 'g');
const scrub = (t: string) => scrubBase(t).replace(realFirstAll, m => inventedFor(m));
for (const p of pages) { p.title = scrub(p.title); p.body = scrub(p.body); p.fm = JSON.parse(scrub(JSON.stringify(p.fm))); }
for (const r of rows) r.question = scrub(r.question);

const words = (s: string) => ' ' + s.toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim() + ' ';
const denyWords = REAL_DENY.map(w => ({ w, padded: words(w) }));
function privacyFindings(): string[] {
  const out: string[] = [];
  const check = (where: string, text: string) => {
    const padded = words(text);
    for (const { w, padded: needle } of denyWords) if (padded.includes(needle)) out.push(where + ': "' + w + '"');
    const m = text.match(realFirstRe);
    if (m) out.push(where + ': common real name "' + m[2] + '"');
  };
  for (const p of pages) check('source-' + p.source + '/' + p.slug, p.title + '\n' + p.body);
  for (const r of rows) check('question ' + r.id, r.question);
  return out;
}
const findings = privacyFindings();
if (findings.length) console.error('[privacy] deny-list hits (' + findings.length + '):\n  ' + findings.slice(0, 40).join('\n  '));

// ---------------------------------------------------------------- Write

function frontmatter(fm: Record<string, unknown>): string {
  const lines = Object.entries(fm).map(([k, v]) => k + ': ' + (typeof v === 'string' || Array.isArray(v) ? JSON.stringify(v) : String(v)));
  return '---\n' + lines.join('\n') + '\n---\n\n';
}
for (const s of ['source-a', 'source-b']) rmSync(join(OUT, s), { recursive: true, force: true });
for (const p of pages) {
  const file = join(OUT, 'source-' + p.source, p.slug + '.md');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, frontmatter(p.fm) + p.body);
}
writeFileSync(join(OUT, 'questions.jsonl'), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

const shapeCounts: Record<string, number> = {};
for (const r of rows) shapeCounts[r.shape] = (shapeCounts[r.shape] ?? 0) + 1;
const summary = {
  pages: pages.length,
  source_a: pages.filter(p => p.source === 'a').length,
  source_b: pages.filter(p => p.source === 'b').length,
  questions: rows.length,
  shapes: shapeCounts,
  longest_body_chars: pages.reduce((m, p) => Math.max(m, p.body.length), 0),
  llm: { model: MODEL, calls: usage.calls, cached: usage.cached, input_tokens: usage.inTok, output_tokens: usage.outTok, est_usd: +(usage.inTok * PRICE_IN + usage.outTok * PRICE_OUT).toFixed(3) },
  privacy_findings: findings.length,
};
writeFileSync(join(OUT, 'README.md'), '# ranking-shapes fixture\n\nSynthetic, fictional corpus for the ranking-shape bench. Generated by ' + '`scripts/bench/ranking-shapes/generate.ts`' + ' (seed ' + SEED + '). Do not hand-edit; rerun the generator.\n\n```json\n' + JSON.stringify({ ...summary, llm: { model: MODEL } }, null, 2) + '\n```\n\n- `source-a/`, `source-b/`: page directories (source-b holds same-slug twins plus a few b-only pages).\n- `questions.jsonl`: one row per question; `related` lists the stub/family/founder/image pages that the shape-specific pass criteria look at.\n- `manifest.json`: slug to role map.\n');
console.error(JSON.stringify(summary, null, 2));
if (findings.length) process.exit(2);
