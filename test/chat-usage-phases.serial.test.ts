/**
 * #7176: every read-path model call lands in chat_usage_log with a phase.
 *
 *   - query expansion (gateway.expand) writes a row with its model, tokens
 *     and phase `expansion`, on every expand() path, even inside a job;
 *   - think's synthesis call writes phase `think` unless a job or cycle
 *     phase already attributes it;
 *   - a query's `cost` meta (#7158) counts the same expansion call on its
 *     own `expansion` line, with the tokens the ledger row carries.
 *
 * Serial: configureGateway and the transport seams are process-wide, and
 * withEnv sets ANTHROPIC_API_KEY.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  __setChatTransportForTests,
  __setEmbedTransportForTests,
  __setGenerateObjectTransportForTests,
  configureGateway,
  expand,
  resetGateway,
  type ChatResult,
} from '../src/core/ai/gateway.ts';
import { setChatUsageSink, withChatPhase, type ChatUsageRecord } from '../src/core/ai/chat-usage.ts';
import { runThink } from '../src/core/think/index.ts';
import { operations } from '../src/core/operations.ts';
import { searchCtx, seedPage } from './helpers/keyword-paging-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const HAIKU = 'anthropic:claude-haiku-4-5-20251001';
let engine: PGLiteEngine;
let rows: ChatUsageRecord[] = [];

function chatResultOf(text: string): ChatResult {
  return {
    text, blocks: [{ type: 'text', text }], stopReason: 'end',
    usage: { input_tokens: 900, output_tokens: 60, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
  };
}

function expansionGateway(): void {
  resetGateway();
  configureGateway({ expansion_model: HAIKU, env: { ANTHROPIC_API_KEY: 'sk-test-fake' } });
  __setGenerateObjectTransportForTests(async () => ({ object: { queries: ['widget cost', 'widget price list'] }, usage: { inputTokens: 120, outputTokens: 40 } }) as never);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedPage(engine, 'notes/widget-pricing', 'Widget pricing for acme-example is set per seat.');
}, 120_000);

afterEach(() => {
  rows = [];
  setChatUsageSink(null);
  __setChatTransportForTests(null);
  __setGenerateObjectTransportForTests(null);
  __setEmbedTransportForTests(null);
  resetGateway();
});

afterAll(async () => { await engine.disconnect(); });

const capture = () => setChatUsageSink(r => { rows.push(r); });

describe('query expansion in chat_usage_log', () => {
  test('a structured expansion writes one row: model, provider, tokens, phase expansion', async () => {
    expansionGateway();
    capture();
    expect(await expand('widget pricing')).toContain('widget cost');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: HAIKU, provider: 'anthropic', phase: 'expansion', input_tokens: 120, output_tokens: 40 });
    expect(rows[0]!.cost_usd).toBeGreaterThan(0);
  });

  test('a job phase does not hide that the call was expansion', async () => {
    expansionGateway();
    capture();
    await withChatPhase('job:example', () => expand('widget pricing'));
    expect(rows.map(r => r.phase)).toEqual(['expansion']);
  });

  test('a failed expansion writes no row (the ledger records successes only)', async () => {
    expansionGateway();
    __setGenerateObjectTransportForTests(async () => { throw new Error('simulated 503'); });
    capture();
    expect(await expand('widget pricing')).toEqual(['widget pricing']);
    expect(rows).toEqual([]);
  });
});

describe('think in chat_usage_log', () => {
  const answer = JSON.stringify({ answer: 'Per seat [notes/widget-pricing].', citations: [{ page_slug: 'notes/widget-pricing', row_num: null, citation_index: 1 }], gaps: [] });

  test('a direct think call records phase think', async () => {
    __setChatTransportForTests(async () => chatResultOf(answer));
    capture();
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-hermetic' }, () => runThink(engine, { question: 'How is widget pricing set?', withTrajectory: false }));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.phase === 'think')).toBe(true);
  });

  test('think inside a job keeps the job phase', async () => {
    __setChatTransportForTests(async () => chatResultOf(answer));
    capture();
    await withEnv({ ANTHROPIC_API_KEY: 'sk-test-hermetic' }, () => withChatPhase('job:example', () => runThink(engine, { question: 'How is widget pricing set?', withTrajectory: false })));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every(r => r.phase === 'job:example')).toBe(true);
  });
});

describe('query cost counts expansion from the same call', () => {
  test('the expansion line matches the ledger row', async () => {
    expansionGateway();
    configureGateway({ expansion_model: HAIKU, embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ANTHROPIC_API_KEY: 'sk-test-fake', OPENAI_API_KEY: 'sk-fake' } });
    __setEmbedTransportForTests((async (args: { values: string[] }) => ({ embeddings: args.values.map(() => Array.from({ length: 1536 }, () => 0.1)), usage: { tokens: 7 } })) as never);
    capture();
    const ctx = searchCtx(engine, false);
    await operations.find(o => o.name === 'query')!.handler(ctx, { query: 'how is widget pricing set', expand: true });
    const cost = (ctx.captured.retrieval as { cost: Record<string, any> }).cost;
    const expansion = rows.filter(r => r.phase === 'expansion');
    expect(expansion).toHaveLength(1);
    expect(cost.expansion).toMatchObject({ calls: 1, input_tokens: expansion[0]!.input_tokens, output_tokens: expansion[0]!.output_tokens });
    expect(cost.expansion.usd).toBeCloseTo(expansion[0]!.cost_usd!, 6);
    expect(cost.chat).toBeUndefined();
  });
});
