/**
 * #7158: every search/query call reports what it spent. The op's retrieval
 * meta (`_meta.retrieval.cost`, the CLI's `--timings` document) counts the
 * request's embedding, rerank and chat calls with their tokens and, when the
 * shipped pricing table has the model, an estimated USD. A rerank whose
 * provider reports no usage is still counted (its request estimate, flagged
 * `estimated_token_calls`), and a concurrent request never sees another's calls.
 *
 * Runs the real search/query ops on PGLite; the embedding and rerank HTTP are
 * stubbed through the gateway transports. Serial: mutates the module-global
 * gateway.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests, __setRerankTransportForTests } from '../src/core/ai/gateway.ts';
import { callSearch, searchCtx, seedPage } from './helpers/keyword-paging-fixture.ts';
import { operations } from '../src/core/operations.ts';

let engine: PGLiteEngine;
let rerankUsage: Record<string, unknown> | null = { total_tokens: 120 };
let embedCalls = 0;
let rerankCalls = 0;

const queryOp = operations.find(o => o.name === 'query')!;

async function callQuery(params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const ctx = searchCtx(engine, false);
  await queryOp.handler(ctx, params);
  return (ctx.captured.retrieval ?? {}) as Record<string, unknown>;
}

function keyless(): void {
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
}

function stubbed(): void {
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    reranker_model: 'voyage:rerank-3-lite', env: { OPENAI_API_KEY: 'sk-fake', VOYAGE_API_KEY: 'pa-fake' } });
  __setEmbedTransportForTests((async (args: any) => {
    embedCalls++;
    return { embeddings: args.values.map(() => Array.from({ length: 1536 }, () => 0.1)), values: args.values, usage: { tokens: 7 } };
  }) as any);
  __setRerankTransportForTests(async (_url, init) => {
    rerankCalls++;
    const docs = (JSON.parse(String(init.body)) as { documents: string[] }).documents;
    return new Response(JSON.stringify({ data: docs.map((_, index) => ({ index, relevance_score: 1 - index / 100 })), ...(rerankUsage ? { usage: rerankUsage } : {}) }), { status: 200 });
  });
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.setConfig('search.reranker.enabled', 'true');
  for (let i = 0; i < 6; i++) await seedPage(engine, `notes/widget-${i}`, `Widget roadmap note ${i} for acme-example covers widget pricing.`);
}, 120_000);

afterAll(async () => {
  __setEmbedTransportForTests(null);
  __setRerankTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

describe('search/query cost meta (#7158)', () => {
  test('a keyword-only run (no embedding key) reports zero model calls and its stage timings', async () => {
    keyless();
    const { rows, retrieval } = await callSearch(engine, { query: 'widget pricing' }, false);
    expect(rows.length).toBeGreaterThan(0);
    expect(retrieval.cost).toBeUndefined();
    const timings = retrieval.timings as { total_ms: number; stages_ms: Record<string, number> };
    expect(timings.total_ms).toBeGreaterThanOrEqual(0);
    expect(timings.stages_ms.lexical).toBeGreaterThanOrEqual(0);
  });

  test('a stubbed embedding + rerank query counts both, with provider tokens and USD', async () => {
    stubbed();
    rerankUsage = { total_tokens: 120 };
    embedCalls = 0;
    rerankCalls = 0;
    const retrieval = await callQuery({ query: 'widget pricing roadmap', expand: false });
    const cost = retrieval.cost as Record<string, any>;
    expect(embedCalls).toBeGreaterThan(0);
    expect(rerankCalls).toBe(1);
    expect(cost.embedding).toMatchObject({ calls: embedCalls, input_tokens: 7 * embedCalls, output_tokens: 0 });
    expect(cost.embedding.estimated_token_calls).toBeUndefined();
    expect(cost.rerank).toMatchObject({ calls: 1, input_tokens: 120, output_tokens: 0 });
    expect(cost.calls).toBe(embedCalls + 1);
    expect(cost.embedding.usd).toBeGreaterThan(0);
    expect(cost.rerank.usd).toBeGreaterThan(0);
    expect(cost.estimated_usd).toBeCloseTo(cost.embedding.usd + cost.rerank.usd, 6);
    expect((retrieval.timings as { stages_ms: Record<string, number> }).stages_ms.rerank).toBeGreaterThanOrEqual(0);
  });

  test('a rerank whose provider reports no usage is still metered from its request estimate', async () => {
    stubbed();
    rerankUsage = null;
    const cost = (await callQuery({ query: 'widget roadmap acme-example', expand: false })).cost as Record<string, any>;
    expect(cost.rerank.calls).toBe(1);
    expect(cost.rerank.estimated_token_calls).toBe(1);
    expect(cost.rerank.input_tokens).toBeGreaterThan(0);
    rerankUsage = { total_tokens: 120 };
  });

  test('concurrent requests each meter only their own calls', async () => {
    stubbed();
    const [keyword, hybrid] = await Promise.all([
      callSearch(engine, { query: 'widget', match: 'keyword' }, false),
      callQuery({ query: 'widget pricing', expand: false }),
    ]);
    expect(keyword.retrieval.cost).toBeUndefined();
    expect((hybrid.cost as Record<string, any>).rerank.calls).toBe(1);
  });
});
