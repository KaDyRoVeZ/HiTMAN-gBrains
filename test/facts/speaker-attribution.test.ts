/**
 * Speaker attribution on saved facts (`facts.attribution`, migration v215).
 *
 * Protects: the attribution variant asks for and parses `attributed_to`
 * (anything outside user|assistant|other parses as null) and the default
 * variant never emits it; the column round-trips through insertFact /
 * insertFacts / list reads and rejects unknown speakers; the fence writes a
 * 15th cell only on rows that carry a speaker, older 10- and 14-cell rows
 * keep their width, an unknown value is a malformed row; every dedup path
 * treats two different known speakers as distinct claims while NULL stays
 * compatible with either (candidate lookup, exact single-fact match, fence
 * reindex, managed batch key via the shared rule, capture exact match,
 * hot-memory collapse); consolidate never promotes an assistant claim into
 * the user's takes; recall and the context-pack line carry the speaker.
 * Seams: gateway chat transport stub; in-memory PGLite.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../../src/core/ai/gateway.ts';
import { extractFactsFromTurnWithOutcome, parseExtractorJson } from '../../src/core/facts/extract.ts';
import { attributionCompatible } from '../../src/core/facts/attribution.ts';
import { parseFactsFence, renderFactsTable, upsertFactRow, type ParsedFact } from '../../src/core/facts-fence.ts';
import { duplicateActiveFenceRows, extractFactsFromFenceText } from '../../src/core/facts/extract-from-fence.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { decideSingleFact } from '../../src/core/facts/single-prepare.ts';
import { collapseHotFacts, findCaptureDuplicate } from '../../src/core/facts/capture-dedup.ts';
import { renderFactLine } from '../../src/core/context/turn-context.ts';
import { runPhaseConsolidate } from '../../src/core/cycle/phases/consolidate.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';

function chatResult(text: string): ChatResult {
  return {
    text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
  } as ChatResult;
}

describe('extractor field', () => {
  beforeEach(() => {
    resetGateway();
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  });
  afterAll(() => {
    __setChatTransportForTests(null);
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ...process.env } });
  });

  const reply = { facts: [
    { fact: 'Assistant recommended the Harbor Hostel in Amsterdam', kind: 'fact', notability: 'high', entity: null, attributed_to: 'assistant' },
    { fact: 'User is planning a trip to Amsterdam', kind: 'event', notability: 'high', entity: null, attributed_to: 'user' },
    { fact: 'User likes canals', kind: 'preference', notability: 'high', entity: null, attributed_to: 'narrator' },
  ] };
  async function run(variant: { attribution?: boolean }) {
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => { seen.push(opts); return chatResult(JSON.stringify(reply)); });
    const outcome = await extractFactsFromTurnWithOutcome({ turnText: 'User: any hostel near the center?\nAssistant: Try the Harbor Hostel.', source: 'test:attribution', variant, embedding: null });
    return { seen, facts: outcome.ok ? outcome.facts : [] };
  }

  test('attribution on: the schema asks for the speaker and each fact keeps it; an unknown speaker parses as null', async () => {
    const { seen, facts } = await run({ attribution: true });
    expect(JSON.stringify(seen[0].responseSchema)).toContain('attributed_to');
    expect(seen[0].system).toContain('"attributed_to"');
    expect(facts.map(f => f.attributed_to ?? null)).toEqual(['assistant', 'user', null]);
  });

  test('attribution off: no speaker in the schema and none on the facts', async () => {
    const { seen, facts } = await run({});
    expect(JSON.stringify(seen[0].responseSchema)).not.toContain('attributed_to');
    expect(facts.every(f => f.attributed_to === undefined)).toBe(true);
  });

  test('parser accepts exactly the three speakers', () => {
    const parsed = parseExtractorJson(JSON.stringify({ facts: ['user', 'assistant', 'other', 'Assistant', 7].map(a => ({ fact: 'x', kind: 'fact', attributed_to: a })) }))!;
    expect(parsed.map(p => p.attributed_to)).toEqual(['user', 'assistant', 'other', null, null]);
  });
});

describe('the compatibility rule', () => {
  test('different known speakers are incompatible; null is compatible with either', () => {
    expect(attributionCompatible('user', 'assistant')).toBe(false);
    expect(attributionCompatible('assistant', 'other')).toBe(false);
    expect(attributionCompatible('user', 'user')).toBe(true);
    expect(attributionCompatible(null, 'assistant')).toBe(true);
    expect(attributionCompatible(undefined, null)).toBe(true);
  });
});

describe('fence column', () => {
  const row = (rowNum: number, over: Partial<ParsedFact> = {}): ParsedFact => ({
    rowNum, claim: `claim ${rowNum}`, kind: 'fact', confidence: 1, visibility: 'private', notability: 'medium',
    validFrom: '2026-03-10', source: 'test', active: true, ...over,
  });
  const dataRows = (table: string) => table.split('\n').filter(l => /^\| \d/.test(l));
  const cells = (line: string) => line.split('|').length - 2;

  test('no attributed row → the 10-cell table, unchanged', () => {
    const table = renderFactsTable([row(1), row(2)]);
    expect(table).not.toContain('attributed_to');
    expect(dataRows(table).map(cells)).toEqual([10, 10]);
  });

  test('mixed rows: only the attributed row is 15 cells wide, typed cells padded; parse round-trips', () => {
    const table = renderFactsTable([row(1), row(2, { attributedTo: 'assistant' }), row(3, { claimMetric: 'mrr', claimValue: 5 })]);
    expect(table).toContain('| claim_period | attributed_to |');
    expect(dataRows(table).map(cells)).toEqual([14, 15, 14]);
    const parsed = parseFactsFence(table);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.facts.map(f => f.attributedTo)).toEqual([undefined, 'assistant', undefined]);
    expect(parsed.facts[2].claimValue).toBe(5);
    expect(renderFactsTable(parsed.facts)).toBe(table);
  });

  test('an unrelated row upsert keeps the speaker cell; an unknown speaker is a malformed row', () => {
    const body = upsertFactRow(upsertFactRow('', { claim: 'Assistant recommended X', kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', attributedTo: 'assistant' }).body,
      { claim: 'User likes Y', kind: 'preference', confidence: 1, visibility: 'private', notability: 'high' }).body;
    expect(parseFactsFence(body).facts.map(f => f.attributedTo)).toEqual(['assistant', undefined]);
    const bad = body.replace('| assistant |', '| narrator |');
    const parsed = parseFactsFence(bad);
    expect(parsed.facts).toHaveLength(1);
    expect(parsed.warnings.join(' ')).toContain('unknown attributed_to "narrator"');
  });

  test('reindex: the speaker reaches the row; same text from two speakers is not a duplicate, a null copy is', () => {
    const facts = [row(1, { claim: 'Lisbon in May', attributedTo: 'user' }), row(2, { claim: 'Lisbon in May', attributedTo: 'assistant' }), row(3, { claim: 'Lisbon in May' })];
    expect([...duplicateActiveFenceRows(facts)]).toEqual([3]);
    expect(extractFactsFromFenceText([facts[1]], 'people/alice-example', 'default')[0].attributed_to).toBe('assistant');
  });
});

describe('storage and dedup (PGLite)', () => {
  let engine: PGLiteEngine;
  const emb = (x: number) => { const v = new Float32Array(1536); v[0] = x; v[1] = 1 - x; v[2] = 0.1; return v; };
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Alice.' });
  }, 120_000);
  afterAll(async () => { if (engine) await engine.disconnect(); });

  test('insertFact and insertFacts store the speaker; reads return it only when set; the column rejects unknown speakers', async () => {
    const a = await engine.insertFact({ fact: 'Assistant recommended the Harbor Hostel', source: 'test', entity_slug: 'people/alice-example', attributed_to: 'assistant' }, { source_id: 'default' });
    await engine.insertFacts([{ fact: 'Alice prefers trains', source: 'test', entity_slug: 'people/alice-example', attributed_to: 'user', row_num: 1, source_markdown_slug: 'people/alice-example' }], { source_id: 'default' });
    const plain = await engine.insertFact({ fact: 'Alice lives in Porto', source: 'test', entity_slug: 'people/alice-example' }, { source_id: 'default' });
    const rows = await engine.listFactsByEntity('default', 'people/alice-example', { activeOnly: true });
    const by = new Map(rows.map(r => [r.fact, r]));
    expect(by.get('Assistant recommended the Harbor Hostel')!.attributed_to).toBe('assistant');
    expect(by.get('Alice prefers trains')!.attributed_to).toBe('user');
    expect('attributed_to' in by.get('Alice lives in Porto')!).toBe(false);
    expect(rows.find(r => r.id === a.id)).toBeDefined();
    expect(plain.status).toBe('inserted');
    await expect(engine.executeRaw(`UPDATE facts SET attributed_to='narrator' WHERE id=$1`, [plain.id])).rejects.toThrow();
  });

  test('candidate lookup drops other speakers before the k cap and keeps NULL rows', async () => {
    await engine.executeRaw(`DELETE FROM facts`);
    const ids: Record<string, number> = {};
    for (const [fact, speaker, x] of [['Hostel pick: Harbor', 'assistant', 0.9], ['Hostel pick: Harbor!', 'user', 0.91], ['Hostel pick Harbor', null, 0.92]] as const) {
      ids[fact] = (await engine.insertFact({ fact, source: 'test', entity_slug: 'people/alice-example', attributed_to: speaker, embedding: emb(x), embedding_model: 'test:emb' }, { source_id: 'default' })).id;
    }
    const facts = (rows: Array<{ fact: string }>) => rows.map(r => r.fact).sort();
    expect(facts(await engine.findCandidateDuplicates('default', 'people/alice-example', 'q', { embedding: emb(0.9), embeddingModel: 'test:emb', k: 5, attributedTo: 'user' })))
      .toEqual(['Hostel pick Harbor', 'Hostel pick: Harbor!']);
    expect(facts(await engine.findCandidateDuplicates('default', 'people/alice-example', 'q', { k: 5, attributedTo: 'assistant' })))
      .toEqual(['Hostel pick Harbor', 'Hostel pick: Harbor']);
    expect(await engine.findCandidateDuplicates('default', 'people/alice-example', 'q', { k: 5 })).toHaveLength(3);
  });

  test('exact single-fact match and capture exact match ignore the same text from another speaker', async () => {
    await engine.executeRaw(`DELETE FROM facts`);
    const assistant = await engine.insertFact({ fact: 'Book the Harbor Hostel', source: 'test', entity_slug: 'people/alice-example', visibility: 'private', attributed_to: 'assistant' }, { source_id: 'default' });
    const intent = { fact: 'Book the Harbor Hostel', kind: 'fact' as const, visibility: 'private' as const, entity_slug: 'people/alice-example' };
    expect((await decideSingleFact(engine, 'default', { ...intent, attributed_to: 'user' }, null)).status).toBe('inserted');
    expect((await decideSingleFact(engine, 'default', { ...intent, attributed_to: 'assistant' }, null)).candidate?.id).toBe(assistant.id);
    expect((await decideSingleFact(engine, 'default', intent, null)).candidate?.id).toBe(assistant.id);
    const scope = { engine, sourceId: 'default', lane: 'test', sessionId: null, anchor: new Date() };
    const candidate = { fact: 'Book the Harbor Hostel', entitySlug: 'people/alice-example', visibility: 'private' as const };
    expect(await findCaptureDuplicate(scope, { ...candidate, attributedTo: 'user' })).toBeNull();
    expect((await findCaptureDuplicate(scope, { ...candidate, attributedTo: 'assistant' }))?.id).toBe(assistant.id);
  });

  test('hot-memory collapse keeps the user and the assistant version of one claim apart', async () => {
    await engine.executeRaw(`DELETE FROM facts`);
    for (const speaker of ['user', 'assistant', 'assistant'] as const) {
      await engine.insertFact({ fact: 'Harbor Hostel in May', source: 'test', entity_slug: 'people/alice-example', attributed_to: speaker }, { source_id: 'default' });
    }
    const rows = await engine.listFactsSince('default', new Date(0), { activeOnly: true, fingerprint: true });
    const collapsed = await collapseHotFacts(engine, 'default', rows);
    expect(collapsed.map(r => r.attributed_to).sort()).toEqual(['assistant', 'user']);
  });

  test('consolidate never promotes assistant claims into the user\'s takes', async () => {
    await engine.executeRaw(`DELETE FROM facts`);
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 3; i++) {
      await engine.insertFact({ fact: `Assistant recommended the Harbor Hostel (${i})`, source: 'test', entity_slug: 'people/alice-example', attributed_to: 'assistant', valid_from: old, embedding: emb(0.5), embedding_model: 'test:emb' }, { source_id: 'default' });
    }
    const result = await runPhaseConsolidate(engine, { sourceId: 'default' });
    expect(result.status).not.toBe('fail');
    const [{ n }] = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM facts WHERE consolidated_at IS NOT NULL`);
    expect(n).toBe(0);
  });

  test('recall returns the speaker; the context-pack line marks assistant claims', async () => {
    await engine.executeRaw(`DELETE FROM facts`);
    await engine.insertFact({ fact: 'Assistant recommended the Harbor Hostel', source: 'test', entity_slug: 'people/alice-example', attributed_to: 'assistant' }, { source_id: 'default' });
    await engine.insertFact({ fact: 'Alice lives in Porto', source: 'test', entity_slug: 'people/alice-example' }, { source_id: 'default' });
    const ctx = { engine, remote: false, sourceId: 'default', config: { engine: 'pglite' }, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const out = await operationsByName.recall.handler(ctx, { entity: 'people/alice-example' }) as { facts: Array<Record<string, unknown>> };
    const by = new Map(out.facts.map(f => [f.fact, f]));
    expect(by.get('Assistant recommended the Harbor Hostel')!.attributed_to).toBe('assistant');
    expect('attributed_to' in by.get('Alice lives in Porto')!).toBe(false);
    const line = (attributed_to?: 'assistant' | 'user') => renderFactLine({ id: 1, fact: 'Harbor Hostel', kind: 'fact', entity_slug: null, confidence: 1, ...(attributed_to ? { attributed_to } : {}) });
    expect(line('assistant')).toBe('- (assistant said) Harbor Hostel (1.00)');
    expect(line('user')).toBe('- Harbor Hostel (1.00)');
    expect(line()).toBe('- Harbor Hostel (1.00)');
  });
});
