/**
 * #7163: identifier-shaped queries (phone numbers, emails, URLs, long digit
 * runs, hex ids, codes like INV-2026-00417). Tokenization splits them, a
 * vector of digits is noise, and the reranker cannot recover a page that
 * never entered the pool, so search runs an exact probe for them before
 * ranking (search/exact-lookup.ts). Pure: detection, the keyword query that
 * finds candidate chunks in every common written format, and the check that
 * a chunk really contains the identifier.
 */

export type IdentifierKind = 'email' | 'url' | 'phone' | 'digits' | 'hex' | 'code';

export interface Identifier {
  kind: IdentifierKind;
  /** The identifier as asked, quotes removed. */
  raw: string;
  /** What a chunk must contain: lowercase text, or the digits of a phone or digit run. */
  needle: string;
}

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const URL_RE = /^(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/?#]\S*)?$/i;
const PHONE_RE = /^\+?[\d\s().-]{7,22}$/;
const HEX_RE = /^(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,64}$/i;
const CODE_RE = /^(?=.*\d)[a-z0-9]{1,12}(?:[-_/][a-z0-9]{1,12}){1,5}$/i;

const digitsOf = (s: string) => s.replace(/\D/g, '');

/** The identifier a whole query names, or null for any other query. */
export function parseIdentifier(query: string): Identifier | null {
  const raw = query.trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!raw || raw.length > 200 || /^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  if (EMAIL_RE.test(raw)) return { kind: 'email', raw, needle: raw.toLowerCase() };
  if (/\s/.test(raw) && !PHONE_RE.test(raw)) return null;
  if (PHONE_RE.test(raw) && /[\s().+-]/.test(raw)) {
    const d = digitsOf(raw);
    if (d.length >= 7 && d.length <= 15) return { kind: 'phone', raw, needle: d };
  }
  if (/^\d{6,}$/.test(raw)) return { kind: 'digits', raw, needle: raw };
  if (HEX_RE.test(raw)) return { kind: 'hex', raw, needle: raw.toLowerCase() };
  if (/[./]/.test(raw) && URL_RE.test(raw) && /[a-z]/i.test(raw)) {
    const needle = raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
    return { kind: 'url', raw, needle };
  }
  if (CODE_RE.test(raw)) return { kind: 'code', raw, needle: raw.toLowerCase() };
  return null;
}

/** National significant number for a phone: the last 10 digits of a longer number, else all of them. */
const nationalDigits = (d: string) => (d.length > 10 ? d.slice(-10) : d);

/**
 * The keyword query (websearch syntax, OR of quoted forms) that finds chunks
 * holding the identifier however it was written: for a ten-digit phone,
 * 4155550142, 415.555.0142, 415-555-0142, (415) 555-0142, 415 555 0142 and
 * the +1 forms all reach the same chunks through the existing full-text index.
 */
export function identifierKeywordQuery(id: Identifier): string {
  if (id.kind !== 'phone') return `"${id.raw.replace(/"/g, '')}"`;
  const n = nationalDigits(id.needle);
  const forms = new Set<string>([id.needle, n]);
  if (n.length === 10) {
    const [a, b, c] = [n.slice(0, 3), n.slice(3, 6), n.slice(6)];
    for (const f of [`${a}.${b}.${c}`, `${a}-${b}-${c}`, `(${a}) ${b}-${c}`, `${a} ${b} ${c}`, `+1 ${a} ${b} ${c}`, `+1${n}`, `1${n}`]) forms.add(f);
  } else if (n.length === 7) {
    forms.add(`${n.slice(0, 3)}-${n.slice(3)}`);
    forms.add(`${n.slice(0, 3)} ${n.slice(3)}`);
  }
  return [...forms].map(f => (/[\s()+-]/.test(f) ? `"${f}"` : f)).join(' OR ');
}

const PHONE_SPAN_RE = /\+?\(?\d[\d\s().-]{5,22}\d/g;

/**
 * Whether `text` contains the identifier: a case-insensitive substring
 * bounded by non-word characters, or for a phone one written phone number
 * whose digits are the asked number (with or without the country code).
 */
export function textContainsIdentifier(text: string, id: Identifier): boolean {
  if (!text) return false;
  if (id.kind === 'phone') {
    const want = nationalDigits(id.needle);
    for (const m of text.matchAll(PHONE_SPAN_RE)) {
      const d = digitsOf(m[0]);
      if (d === id.needle || nationalDigits(d) === want) return true;
    }
    return false;
  }
  const hay = text.toLowerCase();
  let at = hay.indexOf(id.needle);
  while (at >= 0) {
    const before = at === 0 ? '' : hay[at - 1]!;
    const after = hay[at + id.needle.length] ?? '';
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    at = hay.indexOf(id.needle, at + 1);
  }
  return false;
}
