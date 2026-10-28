/**
 * #5902: an embed-stale drain called without a concurrency (the unpaced
 * embed-backfill job, the remediation embed step) leaves half of the
 * engine's real connection pool free.
 *
 * Protects: the default worker count `min(20, max(1, floor(poolMax/2)))`
 * read from `engine.getPoolDiagnostics().poolMax` (a worker's instance pool
 * included), 20 without a pool, an explicit GBRAIN_EMBED_CONCURRENCY keeping
 * the full-pool clamp, and an explicit `concurrency` option winning.
 * Regression: the unconditional default of 20 workers that saturated a
 * 10-connection pool and starved the worker's health probe.
 * Existing coverage: test/embed-concurrency-pool-clamp.test.ts covers the
 * CLI clamp (`resolveEmbedConcurrency`), not this default.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';
import { resolveStaleEmbedConcurrency } from '../src/core/embed-concurrency.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** The PGLite engine reporting a Postgres-style pool of `poolMax`. */
function withPool(poolMax: number): BrainEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'getPoolDiagnostics') return () => ({ poolMax, tracked: {} });
      const value = Reflect.get(target, prop);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
}

async function seed(pages: number): Promise<void> {
  for (let i = 0; i < pages; i++) {
    const slug = `notes/p${i}`;
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\nseeded` });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: `chunk of ${slug}`, chunk_source: 'compiled_truth', token_count: 4, embedding: undefined }]);
  }
}

/** Peak number of keys inside the embed call at once. */
async function peakConcurrency(target: BrainEngine, opts: { concurrency?: number } = {}): Promise<number> {
  let inFlight = 0;
  let peak = 0;
  const result = await embedStaleForSource(target, 'default', {
    ...opts,
    embedFn: async (texts) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 150));
      inFlight--;
      return texts.map(() => { const v = new Float32Array(1536); v[0] = 1; return v; });
    },
  });
  expect(result.embedded).toBe(12);
  return peak;
}

describe('embed-stale default concurrency (#5902)', () => {
  test('the default worker count is half the engine pool, capped at 20; no pool keeps 20', () => {
    const cases: Array<[number | null | undefined, number]> = [[10, 5], [2, 1], [1, 1], [64, 20], [41, 20], [null, 20], [undefined, 20]];
    for (const [poolMax, expected] of cases) {
      const target = { kind: 'postgres', ...(poolMax === undefined ? {} : { getPoolDiagnostics: () => ({ poolMax }) }) };
      expect(resolveStaleEmbedConcurrency(target, {}), String(poolMax)).toBe(expected);
    }
    expect(resolveStaleEmbedConcurrency({ kind: 'pglite' }, {})).toBe(20);
    expect(resolveStaleEmbedConcurrency({ kind: 'postgres', getPoolDiagnostics: () => ({ poolMax: 10 }) }, { GBRAIN_EMBED_CONCURRENCY: '8' })).toBe(8);
    expect(resolveStaleEmbedConcurrency({ kind: 'postgres', getPoolDiagnostics: () => ({ poolMax: 10 }) }, { GBRAIN_EMBED_CONCURRENCY: '30' })).toBe(10);
  });

  test('a pool of 10 peaks at 5 concurrent keys; an instance pool of 2 peaks at 1', async () => {
    await seed(12);
    expect(await peakConcurrency(withPool(10))).toBe(5);
    await resetPgliteState(engine);
    await seed(12);
    expect(await peakConcurrency(withPool(2))).toBe(1);
  }, 60_000);

  test('GBRAIN_EMBED_CONCURRENCY=8 and an explicit concurrency win over the half-pool default', async () => {
    await seed(12);
    expect(await withEnv({ GBRAIN_EMBED_CONCURRENCY: '8' }, () => peakConcurrency(withPool(10)))).toBe(8);
    await resetPgliteState(engine);
    await seed(12);
    expect(await peakConcurrency(withPool(10), { concurrency: 7 })).toBe(7);
  }, 60_000);
});
