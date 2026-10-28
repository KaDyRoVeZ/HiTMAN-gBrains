/**
 * #7171: a statement timeout in the keyword arm dropped the keyword results and
 * the CLI said nothing: the search/query meta stamped `keyword_arm_failed`, but
 * only MCP's dispatch turned that stamp into the `degraded_recall` notice, so a
 * CLI caller (and `--json`, whose array stays bare) read a lost arm as "no
 * matches". The CLI now renders the same notice on stderr.
 * Seams: gateway embed transport stub; engine.searchKeyword patched to throw
 * SQLSTATE 57014; in-memory PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { applyCliOpNotices, captureRetrievalNotices } from '../../src/cli/op-notices.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';

const DIMS = 1536;
function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

describe('keyword-arm statement timeout (PGLite)', () => {
  let engine: PGLiteEngine;
  let meta: Record<string, unknown> | null = null;
  const ctx = {
    get engine() { return engine; }, remote: false, sourceId: 'default', config: { engine: 'pglite' }, dryRun: false,
    logger: { info() {}, warn() {}, error() {} }, emitNotice() {},
    emitResponseMeta: (key: string, value: unknown) => { if (key === 'retrieval') meta = value as Record<string, unknown>; },
  } as unknown as OperationContext;

  beforeAll(async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await importFromContent(engine, 'notes/quokka-habitat', '# Quokka habitat\nQuokka island habitat notes: scrub, burrows and shade.');
    await importFromContent(engine, 'notes/ferries', '# Ferries\nFerry timetable to the island.');
    engine.searchKeyword = async () => { throw Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }); };
  }, 120_000);
  afterAll(async () => {
    __setEmbedTransportForTests(null);
    resetGateway();
    if (engine) await engine.disconnect();
  });

  for (const name of ['search', 'query'] as const) {
    test(`${name}: the vector arm still answers, meta names the keyword arm, and the CLI says so`, async () => {
      meta = null;
      const params = { query: 'quokka island habitat', ...(name === 'query' ? { expand: false } : {}) };
      const rows = await operationsByName[name].handler(ctx, params) as unknown[];
      expect(rows.length).toBeGreaterThan(0);
      expect(meta!.degraded).toContainEqual({ stage: 'keyword_arm_failed', reason: 'timeout' });
      captureRetrievalNotices(name, rows, meta, params, ctx.config);
      const { result, stderr } = applyCliOpNotices(rows, true);
      expect(Array.isArray(result)).toBe(true);
      expect(stderr).toContain('keyword_arm_failed');
    });
  }

  test('a clean call adds no notice', () => {
    captureRetrievalNotices('search', [], { degraded: [] }, { query: 'x' }, ctx.config);
    expect(applyCliOpNotices([], true).stderr).toBeUndefined();
  });
});
