/**
 * Multi-relation query planner: turns a question that chains 2-3 typed
 * relations ("Who founded the companies that Alice Example invested in?")
 * into a chain plan over `links`. Pure: no DB, no LLM, deterministic.
 *
 * How it reads a question:
 *   1. A bounded lexer splits the query into word tokens with spans (no regex
 *      runs over user text beyond a linear tokenizer).
 *   2. Relation phrases are spotted longest-first from a fixed lexicon, each
 *      with its surface form: active verb ("invested in"), passive ("founded
 *      by"), agent noun ("investors of", "Acme's founders") or outgoing noun
 *      ("Alice's portfolio").
 *   3. Fewer than two relations → `not_applicable` (single-relation questions
 *      stay on parseRelationalQuery, unchanged).
 *   4. Everything that is not a relation, question word, auxiliary,
 *      determiner, relative pronoun, polite lead-in, head noun or marker must
 *      form exactly one contiguous span: the anchor entity. A pronoun right
 *      after a verb ("who founded THEM") points back at the previous step, so
 *      that verb reads with the chain on its right.
 *   5. English nests the named entity innermost, so hops run from the
 *      relation nearest the anchor outward (noun forms bind tighter than verbs
 *      at equal distance). Each hop's direction follows from its form and the
 *      side the anchor is on: an active verb with the anchor on its left walks
 *      toward the object, on its right toward the subject; passive forms
 *      invert that; agent nouns walk toward the subject; outgoing nouns toward
 *      the object.
 *   6. Consecutive hops must agree on the page type between them, and a
 *      "who"/"which companies" head must fit the last hop.
 *
 * Refused as `unsupported` (never answered with a one-hop guess): coordination
 * or disjunction of relations (an "and" followed by a back-reference is a
 * sequence, not coordination), negation, dates and time windows (a tense
 * marker right before a relation that can end, "formerly advised", sets that
 * hop's relationship status instead), comparatives,
 * counting, quoted names, more than one candidate anchor, more than three
 * hops, type-incoherent chains.
 *
 * Tested in test/relational-plan.test.ts.
 */

import { LINK_SIGNATURES, linkFamily, MAX_CHAIN_HOPS, type ChainHop } from './relational-chain.ts';
import { parseRelationalQuery } from './relational-intent.ts';
import { relationSemantics, type EdgeStatusFilter } from '../link-validity.ts';

export interface RelationalPlan {
  /** Raw anchor phrase, resolved to a page later (scope-aware). */
  anchor: string;
  /** Anchor-outward hops. */
  hops: ChainHop[];
  /** True for "other/else/also" questions and the co-relation shape. */
  excludeAnchor: boolean;
  /** Matched relation phrases in hop order, for explain. */
  phrases: string[];
}

export type PlanResult =
  | { kind: 'plan'; plan: RelationalPlan }
  | { kind: 'not_applicable' }
  | { kind: 'unsupported'; reason: string };

type Form = 'verb' | 'passive' | 'agent' | 'out' | 'co';

interface LexEntry {
  words: string[];
  rel: string;
  form: Form;
  /** Base-form verbs ("found", "back") count only after an auxiliary ("did X back"). */
  needsAux?: boolean;
}

const w = (s: string) => s.split(' ');

function entries(rel: string, form: Form, phrases: string[], needsAux = false): LexEntry[] {
  return phrases.map(p => ({ words: w(p), rel, form, ...(needsAux ? { needsAux } : {}) }));
}

const LEXICON: LexEntry[] = [
  // founded
  ...entries('founded', 'verb', ['founded', 'co-founded', 'cofounded', 'started', 'founds', 'starts', 'established']),
  ...entries('founded', 'verb', ['found', 'co-found', 'start'], true),
  ...entries('founded', 'passive', ['founded by', 'co-founded by', 'cofounded by', 'started by', 'established by']),
  ...entries('founded', 'out', ["'s startups", "'s startup", "'s ventures", "'s founded companies", "'s founded startups", "'s founded ventures",
    "'s founded businesses", "'s founded firms"]),
  ...entries('founded', 'agent', ['founder', 'founders', 'co-founder', 'co-founders', 'cofounder', 'cofounders', 'founding team']),
  // invested_in
  ...entries('invested_in', 'verb', ['invested in', 'invests in', 'has invested in', 'backed', 'backs', 'funded', 'funds', 'financed', 'finances', 'put money into', 'put money in']),
  ...entries('invested_in', 'verb', ['invest in', 'invested', 'put money into', 'holds an investment in', 'holds investments in', 'hold an investment in',
    'holds a stake in', 'holds stakes in', 'hold stakes in', 'has money in', 'have money in', 'has a stake in', 'has stakes in', 'is an investor in',
    'are investors in', 'was an investor in', 'invested money in', 'provided investment to',
    'holds an investment', 'holds investments', 'holds a stake', 'holds stakes']),
  ...entries('invested_in', 'verb', ['back', 'fund', 'finance'], true),
  ...entries('invested_in', 'passive', ['backed by', 'funded by', 'financed by']),
  ...entries('invested_in', 'agent', ['investor', 'investors', 'backer', 'backers', 'funder', 'funders', 'shareholders']),
  ...entries('invested_in', 'out', ['portfolio', 'portfolio companies', 'portfolio company', 'investments']),
  ...entries('invested_in', 'co', ['co-investor', 'co-investors', 'coinvestors']),
  // advises
  ...entries('advises', 'verb', ['advises', 'advised', 'advising']),
  ...entries('advises', 'verb', ['advise', 'serves as an advisor', 'serves as advisor', 'serves as an advisor to', 'serves as an advisor for', 'serves as an advisor on', 'serves as advisor to',
    'serve as an advisor to', 'is an advisor to', 'is an adviser to', 'acts as an advisor to', 'is an advisor for']),
  ...entries('advises', 'passive', ['advised by']),
  ...entries('advises', 'agent', ['advisor', 'advisors', 'adviser', 'advisers', 'advisory board']),
  // works_at
  ...entries('works_at', 'verb', ['works at', 'worked at', 'works for', 'worked for', 'working at', 'working for', 'employed at', 'employed by', 'is on the team at']),
  ...entries('works_at', 'verb', ['work at', 'work for']),
  ...entries('works_at', 'agent', ['employee', 'employees', 'staff', 'team members']),
  ...entries('works_at', 'out', ['employer', 'employers']),
  // attended
  ...entries('attended', 'verb', ['attended']),
  ...entries('attended', 'verb', ['attend']),
  ...entries('attended', 'passive', ['attended by']),
  ...entries('attended', 'agent', ['attendees']),
].sort((a, b) => b.words.length - a.words.length);

const WH = new Set(['who', 'whom', 'which', 'what']);
const AUX = new Set(['did', 'does', 'do', 'has', 'have', 'had', 'is', 'are', 'was', 'were']);
const DO_AUX = new Set(['did', 'does', 'do', 'has', 'have', 'had']);
const DETERMINERS = new Set(['the', 'a', 'an', 'all', 'any', 'their', 'its', 'his', 'her', 'each', 'every', 'some', 'those', 'these', 'same', 'them', 'they', 'it']);
const RELATIVE = new Set(['that', 'which', 'who', 'whom']);
const HEAD_LEAD = new Set(['among', 'of', 'our', 'my']);
const PREPS = new Set(['of', 'in', 'at', 'behind', 'for', 'to', 'into', 'with']);
const POLITE = new Set(['list', 'show', 'name', 'find', 'give', 'me', 'tell', 'please', 'us', 'could', 'can', 'would', 'you', 'i', 'know', 'want', 'like', 'wondering', 'curious', 'see']);
/**
 * Tense markers right before a state relation pick which relationships that
 * hop walks under relationship validity ("formerly advised" → ended, "used to
 * work at" → all). Dates and other time words stay refused.
 */
const TENSE: Readonly<Record<string, EdgeStatusFilter>> = {
  former: 'ended', formerly: 'ended', previously: 'ended', past: 'ended', current: 'live', currently: 'live',
};
/** Pronouns pointing back at the previous step's pages ("..., who founded THEM"). */
const BACKREF = new Set(['them', 'those', 'these', 'they']);
/** Head nouns that name no page type ("which other PARTIES invested ..."). */
const GENERIC_HEADS = new Set(['parties', 'entities', 'ones', 'additional']);
const OTHER_MARKERS = new Set(['other', 'others', 'else', 'also']);
const HEAD_TYPES: Readonly<Record<string, string>> = {
  people: 'person', person: 'person', persons: 'person', individuals: 'person', folks: 'person', angels: 'person',
  companies: 'company', company: 'company', startups: 'company', startup: 'company', firms: 'company', firm: 'company',
  businesses: 'company', organizations: 'company', funds: 'company', fund: 'company', vcs: 'company',
  meetings: 'meeting', meeting: 'meeting', events: 'meeting',
};
const REFUSE: Readonly<Record<string, string>> = {
  and: 'coordination', or: 'coordination', nor: 'coordination', but: 'coordination',
  not: 'negation', never: 'negation', no: 'negation', without: 'negation', except: 'negation', "n't": 'negation',
  before: 'time', after: 'time', since: 'time', during: 'time', until: 'time', ago: 'time',
  recently: 'time', year: 'time', years: 'time',
  most: 'comparative', more: 'comparative', least: 'comparative', fewest: 'comparative', top: 'comparative',
  many: 'count', count: 'count', number: 'count',
};

interface Tok { text: string; lower: string; start: number; end: number }

/** Linear tokenizer: words (letters, digits, hyphen, period inside names), possessive markers, punctuation dropped. */
function tokenize(q: string): Tok[] {
  const toks: Tok[] = [];
  const re = /[\p{L}\p{N}][\p{L}\p{N}.&-]*|['’]s\b|['’]|["“”]/gu;
  for (const m of q.matchAll(re)) {
    let text = m[0];
    let start = m.index!;
    if (/^["“”]$/.test(text)) { toks.push({ text, lower: '"', start, end: start + 1 }); continue; }
    if (text.endsWith('.')) text = text.replace(/\.+$/, '');
    const lower = text.toLowerCase().replace('’', "'");
    if (lower.endsWith("n't") && lower.length > 3) {
      toks.push({ text: text.slice(0, -3), lower: lower.slice(0, -3), start, end: start + text.length - 3 });
      start += text.length - 3;
      toks.push({ text: "n't", lower: "n't", start, end: start + 3 });
      continue;
    }
    toks.push({ text, lower: lower === "'s" || lower === "'" ? "'s" : lower, start, end: start + text.length });
  }
  return toks;
}

interface Rel { entry: LexEntry; from: number; to: number }

/** Plan a multi-relation question, or say why not. */
export function parseRelationalPlan(query: string): PlanResult {
  if (!query || query.length > 512) return { kind: 'not_applicable' };
  const toks = tokenize(query);
  let lead = 0;
  while (lead < toks.length && POLITE.has(toks[lead].lower)) lead++;
  const hasAux = toks.some(t => AUX.has(t.lower));

  const rels: Rel[] = [];
  const used = new Array<boolean>(toks.length).fill(false);
  for (let i = 0; i < toks.length; i++) {
    if (used[i]) continue;
    for (const e of LEXICON) {
      if (i + e.words.length > toks.length) continue;
      if (!e.words.every((word, j) => toks[i + j].lower === word)) continue;
      if (e.needsAux && !hasAux) continue;
      rels.push({ entry: e, from: i, to: i + e.words.length - 1 });
      for (let j = i; j < i + e.words.length; j++) used[j] = true;
      break;
    }
  }
  // An agent noun right after the question word is the question's head, not a
  // relation ("WHICH INVESTORS backed ...", "who among our FOUNDERS ...").
  // "WHO are the founders of ..." asks for the relation, so a bare who/whom heads only with "among"/"of".
  const headLead = toks.slice(lead, rels[0]?.from ?? lead);
  if (rels.length > 0 && rels[0].entry.form === 'agent' && rels[0].from > lead && WH.has(toks[lead]?.lower)
      && (!['who', 'whom'].includes(toks[lead].lower) || headLead.some(t => t.lower === 'among' || t.lower === 'of'))
      && headLead.every(t => WH.has(t.lower) || DETERMINERS.has(t.lower) || OTHER_MARKERS.has(t.lower) || HEAD_LEAD.has(t.lower))) {
    rels.shift();
  }
  // "the CO-INVESTORS in the companies X INVESTED IN": the co-relation already
  // walks out and back over that relation, so its verb is not another hop.
  const co = rels.find(r => r.entry.form === 'co');
  if (co) for (let k = rels.length - 1; k >= 0; k--) if (rels[k] !== co && rels[k].entry.rel === co.entry.rel) rels.splice(k, 1);
  const relCount = rels.reduce((n, r) => n + (r.entry.form === 'co' ? 2 : 1), 0);
  if (relCount < 2) return { kind: 'not_applicable' };
  if (toks.some(t => t.lower === '"')) return { kind: 'unsupported', reason: 'quoted names are not planned' };

  for (const [i, t] of toks.entries()) {
    if (t.lower === 'and' && toks.slice(i + 1).some(n => BACKREF.has(n.lower))) continue;
    const why = REFUSE[t.lower] ?? (/^(1[89]|20)\d\d$/.test(t.lower) ? 'time' : undefined);
    if (why) return { kind: 'unsupported', reason: `${why} constraints are not planned ("${t.text}")` };
  }
  const tenseOf = new Map<Rel, EdgeStatusFilter>();
  const tenseTok = new Set<number>();
  for (let i = 0; i < toks.length; i++) {
    const usedTo = toks[i].lower === 'used' && toks[i + 1]?.lower === 'to';
    const status = usedTo ? 'all' : TENSE[toks[i].lower];
    if (!status) continue;
    const marker = query.slice(toks[i].start, toks[usedTo ? i + 1 : i].end);
    let j = i + (usedTo ? 2 : 1);
    while (j < toks.length && DETERMINERS.has(toks[j].lower)) j++;
    const rel = rels.find(r => r.from === j);
    if (!rel) return { kind: 'unsupported', reason: `time constraints are not planned ("${marker}")` };
    if (relationSemantics(rel.entry.rel) !== 'state') return { kind: 'unsupported', reason: `${rel.entry.rel} does not end, so "${marker}" is not planned` };
    tenseOf.set(rel, status);
    tenseTok.add(i);
    if (usedTo) tenseTok.add(i + 1);
  }
  for (const r of rels) if (!tenseOf.has(r) && toks[r.from].lower === 'worked' && r.entry.rel === 'works_at') tenseOf.set(r, 'all');
  if (relCount > MAX_CHAIN_HOPS) return { kind: 'unsupported', reason: `more than ${MAX_CHAIN_HOPS} relations` };

  // Classify every non-relation token; leftovers form the anchor.
  let headType: string | null = null;
  let excludeAnchor = false;
  const leftover: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (used[i] || tenseTok.has(i)) continue;
    const l = toks[i].lower;
    if (OTHER_MARKERS.has(l)) { excludeAnchor = true; continue; }
    if (l === "'s" || l === 'and' || GENERIC_HEADS.has(l)) continue;
    if (WH.has(l) || AUX.has(l) || DETERMINERS.has(l) || RELATIVE.has(l) || PREPS.has(l) || POLITE.has(l) || l === 'by' || l === 'whose') {
      if ((l === 'who' || l === 'whom') && headType === null && i === lead) headType = 'person';
      continue;
    }
    if (HEAD_TYPES[l]) {
      const leading = toks.slice(0, i).every(t => WH.has(t.lower) || POLITE.has(t.lower) || DETERMINERS.has(t.lower));
      if (headType === null && leading) headType = HEAD_TYPES[l];
      continue;
    }
    leftover.push(i);
  }
  if (leftover.length === 0) return { kind: 'unsupported', reason: 'no entity named' };
  if (!leftover.every((idx, k) => k === 0 || idx === leftover[k - 1] + 1)) return { kind: 'unsupported', reason: 'more than one candidate entity' };
  const aStart = leftover[0];
  const aEnd = leftover[leftover.length - 1];
  const anchor = query.slice(toks[aStart].start, toks[aEnd].end).trim();
  if (anchor.length === 0 || anchor.length > 80) return { kind: 'unsupported', reason: 'entity name out of bounds' };
  if (rels.some(r => r.from <= aEnd && r.to >= aStart)) return { kind: 'unsupported', reason: 'entity name overlaps a relation' };

  // Order hops anchor-outward. The main-clause verb ("WHO founded ...",
  // "which companies DID ... back") is always outermost; the rest order by
  // how many content tokens separate them from the anchor, nouns binding
  // tighter than verbs at equal distance.
  const scaffold = (l: string) => TENSE[l] !== undefined || WH.has(l) || AUX.has(l) || DETERMINERS.has(l) || POLITE.has(l) || OTHER_MARKERS.has(l) || GENERIC_HEADS.has(l) || HEAD_TYPES[l] !== undefined;
  const isVerb = (r: Rel) => r.entry.form === 'verb' || r.entry.form === 'passive';
  const startsWithWh = lead < toks.length && WH.has(toks[lead].lower);
  // "which companies DID alice back": the auxiliary is followed by its subject,
  // not by a relation ("which parties HAVE invested in" is perfect tense).
  const auxInverted = startsWithWh && toks.slice(lead + 1, lead + 4).some((t, k) => DO_AUX.has(t.lower) && !used[lead + 2 + k]);
  const lastRel = rels.reduce((a, b) => (b.from > a.from ? b : a));
  const isMain = (r: Rel) => isVerb(r) && (
    (startsWithWh && toks.slice(0, r.from).every(t => scaffold(t.lower))) ||
    (auxInverted && r === lastRel && r.to === toks.length - 1)
  );
  const skip = (l: string) => TENSE[l] !== undefined || l === 'used' || DETERMINERS.has(l) || PREPS.has(l) || RELATIVE.has(l) || AUX.has(l) || OTHER_MARKERS.has(l) || l === "'s" || l === 'by' || l === 'whose';
  const dist = (r: Rel) => {
    const [a, b] = r.to < aStart ? [r.to + 1, aStart] : [aEnd + 1, r.from];
    return toks.slice(a, b).filter((t, k) => !used[a + k] && !skip(t.lower)).length + toks.slice(a, b).filter((_, k) => used[a + k]).length;
  };
  const nounish = (r: Rel) => (isVerb(r) ? 1 : 0);
  const possessive = (r: Rel) => (r.entry.words[0] === "'s" && r.from === aEnd + 1 ? 0 : 1);
  const ordered = [...rels].sort((a, b) =>
    Number(isMain(a)) - Number(isMain(b)) || possessive(a) - possessive(b) || dist(a) - dist(b) || nounish(a) - nounish(b) || a.from - b.from);

  const hops: ChainHop[] = [];
  const phrases: string[] = [];
  for (const r of ordered) {
    const anchorOnLeft = aEnd < r.from && !BACKREF.has(toks[r.to + 1]?.lower ?? '');
    const lts = linkFamily(r.entry.rel);
    const phrase = query.slice(toks[r.from].start, toks[r.to].end);
    if (r.entry.form === 'co') {
      hops.push({ linkTypes: lts, toward: 'object' }, { linkTypes: lts, toward: 'subject' });
      excludeAnchor = true;
      phrases.push(phrase, phrase);
      continue;
    }
    let toward: 'object' | 'subject';
    switch (r.entry.form) {
      case 'verb': toward = anchorOnLeft ? 'object' : 'subject'; break;
      case 'passive': toward = anchorOnLeft ? 'subject' : 'object'; break;
      case 'agent': toward = 'subject'; break;
      case 'out': toward = 'object'; break;
    }
    const status = tenseOf.get(r);
    hops.push({ linkTypes: lts, toward, ...(status ? { status } : {}) });
    phrases.push(phrase);
  }
  if (hops.length > MAX_CHAIN_HOPS) return { kind: 'unsupported', reason: `more than ${MAX_CHAIN_HOPS} relations` };

  // Co-relation shape: the last hop walks back over the relation just walked.
  const last = hops[hops.length - 1];
  const prev = hops[hops.length - 2];
  if (prev && last.linkTypes[0] === prev.linkTypes[0] && last.toward !== prev.toward) excludeAnchor = true;

  // Type coherence along the chain, then the head noun on the last hop.
  let types: Set<string> | null = null;
  for (const h of hops) {
    const sig = LINK_SIGNATURES[h.linkTypes[0]];
    const entry = new Set(h.toward === 'object' ? sig.subject : sig.object);
    if (types && ![...types].some(t => entry.has(t))) return { kind: 'unsupported', reason: 'the relations do not chain (page types disagree)' };
    types = new Set(h.toward === 'object' ? sig.object : sig.subject);
  }
  if (headType) {
    if (!types!.has(headType)) return { kind: 'unsupported', reason: `the question asks for ${headType} pages but the last relation returns ${[...types!].join('/')}` };
    if (types!.size > 1) hops[hops.length - 1] = { ...last, nodeType: headType };
  }
  return { kind: 'plan', plan: { anchor, hops, excludeAnchor, phrases } };
}


/**
 * Does this query count as relational for ranking decisions (keyword-arm
 * confidence, intent weighting)? A planned multi-relation question counts only
 * when the planner is on, so planner-off search is exactly today's.
 */
export function isRelationalQuery(query: string, plannerOn: boolean): boolean {
  if (parseRelationalQuery(query) !== null) return true;
  return plannerOn && parseRelationalPlan(query).kind === 'plan';
}
