/**
 * Multi-hop chains through the public ops (keyless brain, planner on).
 *
 * Protects: `search` returns chain answers with their `relational` evidence
 * (also in remote lean rows) and a `relational_plan` summary; a planned
 * question whose anchor is not found carries a `relational_chain` notice with
 * the next call; keyless `recall` routes a chain question through the
 * relational arm and keeps the evidence; planner off leaves both ops as
 * before. Regression it catches: evidence stripped by the op projections,
 * keyless recall bypassing the relational arm, a silent no-answer.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import type { Notice } from '../src/core/agent-output.ts';

let engine: PGLiteEngine;
const Q = 'Who founded the companies that Alice Example invested in?';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const page = async (slug: string, type: string, title: string, body: string) => {
    await engine.putPage(slug, { type: type as 'person', title, compiled_truth: body, timeline: '' });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: body }]);
  };
  await page('people/alice-example', 'person', 'Alice Example', 'Alice is a seed investor.');
  await page('companies/widget-co', 'company', 'Widget Co', 'A payments company.');
  await page('people/frank-example', 'person', 'Frank Example', 'Frank builds payment rails.');
  await engine.addLink('people/alice-example', 'companies/widget-co', 'alice backed widget', 'invested_in', 'markdown');
  await engine.addLink('companies/widget-co', 'people/frank-example', 'founded by Frank', 'founded', 'markdown');
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

function call(remote: boolean) {
  const notices: Notice[] = [];
  const meta: Record<string, unknown> = {};
  const ctx = {
    engine, config: { engine: 'pglite', embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote,
    sourceId: 'default', emitNotice: (n: Notice) => { notices.push(n); }, emitResponseMeta: (k: string, v: unknown) => { meta[k] = v; },
  } as unknown as OperationContext;
  return { ctx, notices, meta };
}

async function withPlanner<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  await engine.setConfig('search.relational_planner', on ? 'true' : 'false');
  try { return await fn(); } finally { await engine.setConfig('search.relational_planner', 'false'); }
}

describe('search', () => {
  test('planner on: the founder arrives with chain evidence and a relational_plan summary', async () => {
    const c = call(false);
    const rows = await withPlanner(true, () => operationsByName.search.handler(c.ctx, { query: Q })) as any[];
    const frank = rows.find(r => r.slug === 'people/frank-example');
    expect(frank?.relational).toMatchObject({ role: 'answer', seed: 'people/alice-example' });
    expect(JSON.stringify(c.meta)).toContain('"relational_plan"');
  });

  test('remote lean rows keep the evidence field', async () => {
    const c = call(true);
    const rows = await withPlanner(true, () => operationsByName.search.handler(c.ctx, { query: Q })) as any[];
    expect(rows.find(r => r.slug === 'people/frank-example')?.relational?.role).toBe('answer');
  });

  test('an unknown anchor carries a relational_chain notice naming the next call', async () => {
    const c = call(false);
    await withPlanner(true, () => operationsByName.search.handler(c.ctx, { query: 'Who founded the companies that Nobody Example invested in?' }));
    expect(c.notices.find(n => n.code === 'relational_chain')).toMatchObject({ fix: { mcp: { tool: 'search' } } });
  });

  test('planner off: no chain evidence', async () => {
    const c = call(false);
    const rows = await withPlanner(false, () => operationsByName.search.handler(c.ctx, { query: Q })) as any[];
    expect(rows.some(r => r.relational !== undefined)).toBe(false);
  });
});

describe('recall (keyless)', () => {
  test('a chain question routes through the relational arm and keeps the evidence', async () => {
    const c = call(false);
    const res = await withPlanner(true, () => operationsByName.recall.handler(c.ctx, { query: Q })) as any;
    expect(res.results.find((r: any) => r.slug === 'people/frank-example')?.relational?.role).toBe('answer');
  });

  test('planner off: keyless recall is the plain keyword path', async () => {
    const c = call(false);
    const res = await withPlanner(false, () => operationsByName.recall.handler(c.ctx, { query: Q })) as any;
    expect((res.results ?? []).some((r: any) => r.relational !== undefined)).toBe(false);
  });
});
