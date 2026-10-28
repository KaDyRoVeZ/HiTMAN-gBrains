/**
 * Date-grounded and speaker-attributed fact extraction (prompt variants).
 *
 * Protects: with both variants off the extractor prompt and schema are
 * byte-identical to the historical ones; with date grounding on, the system
 * prompt carries the shared relative-date rule, the user message carries the
 * observation date (or says unknown — never today's date), and a validated
 * extractor-stated event date becomes the fact's valid_from while malformed
 * or out-of-range dates are dropped; the attribution variant adds the speaker
 * rule; the conversation extractor never treats an epoch fallback as an
 * observation date.
 * Seams: gateway chat transport stub (no provider call).
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import { buildExtractorSystem, extractFactsFromTurnWithOutcome, getExtractorVariant, isConsumerDateGroundingOn } from '../../src/core/facts/extract.ts';
import { observationDateRule } from '../../src/core/ai/date-grounding.ts';
import { segmentObservationDate } from '../../src/commands/extract-conversation-facts.ts';
import type { Page } from '../../src/core/types.ts';

function chatResult(text: string): ChatResult {
  return {
    text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
  } as ChatResult;
}

beforeEach(() => {
  resetGateway();
  __setChatTransportForTests(null);
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
});
afterAll(() => {
  __setChatTransportForTests(null);
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ...process.env } });
});

async function run(variant: { dateGrounding?: boolean; attribution?: boolean }, reply: unknown, observationDate: { date: string; source: 'filename' } | null = null) {
  const seen: ChatOpts[] = [];
  __setChatTransportForTests(async (opts) => { seen.push(opts); return chatResult(JSON.stringify(reply)); });
  const outcome = await extractFactsFromTurnWithOutcome({
    turnText: 'User (2026-03-10): I flew to Lisbon last week.', source: 'test:grounding', variant, observationDate, embedding: null,
  });
  return { seen, outcome };
}

describe('extractor prompt variants', () => {
  test('both off → the historical prompt, schema and user message', async () => {
    expect(buildExtractorSystem(true, {})).toBe(buildExtractorSystem(true));
    const { seen } = await run({}, { facts: [] }, { date: '2026-03-10', source: 'filename' });
    expect(seen[0].system).toBe(buildExtractorSystem(true));
    expect(JSON.stringify(seen[0].responseSchema)).not.toContain('valid_from');
    expect((seen[0].messages[0].content as string).startsWith('<turn>')).toBe(true);
  });

  test('grounding on → rule in the system prompt, observation date in the user message, valid_from in the schema', async () => {
    const { seen } = await run({ dateGrounding: true }, { facts: [] }, { date: '2026-03-10', source: 'filename' });
    expect(seen[0].system).toContain(observationDateRule());
    expect(seen[0].messages[0].content as string).toStartWith('Observation date: 2026-03-10');
    expect(JSON.stringify(seen[0].responseSchema)).toContain('valid_from');
  });

  test('grounding on with no observation date says unknown, never a guessed date', async () => {
    const { seen } = await run({ dateGrounding: true }, { facts: [] }, null);
    expect(seen[0].messages[0].content as string).toStartWith('Observation date: unknown');
  });

  test('attribution on → the speaker rule; off → absent', async () => {
    expect(buildExtractorSystem(true, { attribution: true })).toContain('Assistant recommended');
    expect(buildExtractorSystem(true)).not.toContain('Assistant recommended');
  });
});

describe('extractor-stated event dates', () => {
  test('a valid date becomes valid_from; malformed and far-future dates are dropped; grounding off ignores the field', async () => {
    const reply = { facts: [
      { fact: 'User flew to Lisbon the week of 2026-03-02', kind: 'event', notability: 'high', valid_from: '2026-03-04' },
      { fact: 'User plans a trip', kind: 'event', notability: 'high', valid_from: 'next spring' },
      { fact: 'User will retire', kind: 'event', notability: 'high', valid_from: '2099-01-01' },
    ] };
    const on = await run({ dateGrounding: true }, reply, { date: '2026-03-10', source: 'filename' });
    expect(on.outcome.ok).toBe(true);
    const facts = on.outcome.ok ? on.outcome.facts : [];
    expect(facts[0].valid_from?.toISOString()).toBe('2026-03-04T00:00:00.000Z');
    expect(facts[1].valid_from).toBeUndefined();
    expect(facts[2].valid_from).toBeUndefined();
    const off = await run({}, reply);
    expect(off.outcome.ok && off.outcome.facts.every(f => f.valid_from === undefined)).toBe(true);
  });
});

describe('segmentObservationDate', () => {
  const page = (fm: Record<string, unknown>, slug = 'conversations/chat-x'): Pick<Page, 'slug' | 'frontmatter' | 'effective_date'> =>
    ({ slug, frontmatter: fm, effective_date: null } as Pick<Page, 'slug' | 'frontmatter' | 'effective_date'>);
  test('an explicit transcript timestamp is the observation date', () => {
    expect(segmentObservationDate(page({}), '2026-03-10T09:00:00Z')).toEqual({ date: '2026-03-10', source: 'caller' });
  });
  test('the epoch fallback is never an observation date; a dated slug still is', () => {
    expect(segmentObservationDate(page({}), '1970-01-01T00:00:00Z')).toBeNull();
    expect(segmentObservationDate(page({}, 'daily/2026-02-01'), '1970-01-01T00:00:00Z')).toEqual({ date: '2026-02-01', source: 'filename' });
  });
  test('a frontmatter date drives the segment date', () => {
    expect(segmentObservationDate(page({ date: '2025-12-24' }), '2025-12-24T00:00:00Z')).toEqual({ date: '2025-12-24', source: 'caller' });
  });
});

describe('defaults from the verdicts', () => {
  const engineWith = (v: string | null) => ({ getConfig: async (k: string) => (k === 'extraction.date_grounding' ? v : null) }) as never;
  test('unset: fact extraction, synthesis, atoms and takes grounded; chronicle not', async () => {
    expect((await getExtractorVariant(engineWith(null))).dateGrounding).toBe(true);
    for (const c of ['synthesis', 'atoms', 'takes'] as const) expect(await isConsumerDateGroundingOn(engineWith(null), c)).toBe(true);
    expect(await isConsumerDateGroundingOn(engineWith(null), 'chronicle')).toBe(false);
  });
  test('facts.attribution defaults on; false/off/0 opt out', async () => {
    const attr = (v: string | null) => ({ getConfig: async (k: string) => (k === 'facts.attribution' ? v : null) }) as never;
    expect((await getExtractorVariant(attr(null))).attribution).toBe(true);
    for (const v of ['false', 'off', '0']) expect((await getExtractorVariant(attr(v))).attribution).toBe(false);
  });
  test('true turns every prompt on; false turns every prompt off', async () => {
    for (const c of ['chronicle', 'synthesis', 'atoms', 'takes'] as const) {
      expect(await isConsumerDateGroundingOn(engineWith('true'), c)).toBe(true);
      expect(await isConsumerDateGroundingOn(engineWith('false'), c)).toBe(false);
    }
    expect((await getExtractorVariant(engineWith('off'))).dateGrounding).toBe(false);
  });
});
