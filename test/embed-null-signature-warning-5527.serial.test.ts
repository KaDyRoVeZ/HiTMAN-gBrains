import { installFixtureChunks } from './helpers/page-projection.ts';
/**
 * #5527: the "previous model's embedding space" warning counts only chunks
 * that really are in another space.
 *
 * Protects: an `embed --stale` run (no `--include-null-signature`) on a brain
 * whose NULL-signature pages carry vectors already embedded by the current
 * model, width and text does not tell the operator those vectors sit in the
 * previous model's space; chunks embedded by another model still trigger it.
 * Fails when: the warning subtracts only the narrow stale count, so
 * current-space chunks on unstamped pages are reported as mixed-space.
 * Installs the process-global gateway transport seam (always fake), so this
 * stays a `.serial.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { runEmbedCore } from '../src/commands/embed.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const DIMS = 1536;
const MODEL = 'openai:text-embedding-3-large';

async function seed(engine: BrainEngine, slug: string, model: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
  await installFixtureChunks(engine, slug, [{
    chunk_index: 0, chunk_text: `${slug} body`, chunk_source: 'compiled_truth', token_count: 4,
    embedding: new Float32Array(DIMS).fill(0.002), model,
  }]);
}

beforeAll(() => {
  configureGateway({ embedding_model: MODEL, embedding_dimensions: DIMS, env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' } });
  __setEmbedTransportForTests((async (input: { values: string[] }) =>
    ({ embeddings: input.values.map(() => new Array(DIMS).fill(0.001)), usage: { tokens: input.values.length * 4 } })) as never);
});
afterAll(() => { __setEmbedTransportForTests(null); resetGateway(); });

describe('#5527 null-signature mixed-space warning', () => {
  let engine: BrainEngine;
  let stderr: string[] = [];
  const capture = () => {
    stderr = [];
    const spy = spyOn(console, 'error').mockImplementation((...args: unknown[]) => { stderr.push(args.join(' ')); });
    return spy;
  };
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ embedding_dimensions: DIMS } as never);
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });
  afterEach(() => { stderr = []; });

  test('current-model vectors on unstamped pages are not reported as another space', async () => {
    await seed(engine, 'current-a', MODEL);
    await seed(engine, 'current-b', MODEL);
    const spy = capture();
    try { await runEmbedCore(engine, { stale: true, catchUp: true, quiet: true }); } finally { spy.mockRestore(); }
    expect(stderr.filter(line => line.includes("previous model's"))).toEqual([]);
  });

  test('vectors from another model still warn, counting only those chunks', async () => {
    await seed(engine, 'legacy-a', 'legacy:model');
    const spy = capture();
    try { await runEmbedCore(engine, { stale: true, catchUp: true, quiet: true }); } finally { spy.mockRestore(); }
    const warning = stderr.find(line => line.includes("previous model's"));
    expect(warning).toContain('WARNING: 1 embedded chunk(s)');
  });
});
