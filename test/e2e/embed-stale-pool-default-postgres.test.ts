/**
 * #5902 on real Postgres: an embed-stale drain called without a concurrency
 * runs half as many workers as the engine's actual pool
 * (`getPoolDiagnostics().poolMax` read from the postgres.js client), so a
 * worker job leaves connections for the health probe.
 *
 * Protects: the default reading the real pool of an instance-pool engine
 * (the worker shape, E17) and of the module-pool engine (default size), not
 * a configured guess. Regression: the unconditional 20 workers on a 4- or
 * 10-connection pool.
 * Existing coverage: test/embed-stale-pool-default.test.ts fakes the pool on
 * PGLite; this pins that PostgresEngine reports the pool the default uses.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { embedStaleForSource } from '../../src/core/embed-stale.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';

const DATABASE_URL = requirePostgresTestDatabase();

async function seed(engine: PostgresEngine, pages: number): Promise<void> {
  for (let i = 0; i < pages; i++) {
    const slug = `notes/p${i}`;
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\nseeded` });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: `chunk of ${slug}`, chunk_source: 'compiled_truth', token_count: 4, embedding: undefined }]);
  }
}

async function peak(engine: PostgresEngine, dims: number): Promise<number> {
  let inFlight = 0;
  let max = 0;
  const result = await embedStaleForSource(engine, 'default', {
    embedFn: async (texts) => {
      inFlight++;
      max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 150));
      inFlight--;
      return texts.map(() => { const v = new Float32Array(dims); v[0] = 1; return v; });
    },
  });
  expect(result.embedded).toBe(12);
  return max;
}

async function embeddingDims(engine: PostgresEngine): Promise<number> {
  const [row] = await engine.executeRaw<{ dims: number }>(
    `SELECT atttypmod AS dims FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding'`,
  );
  return Number(row?.dims ?? 1536);
}

for (const style of ['instance', 'module'] as const) describe(`#5902 embed-stale default concurrency on Postgres (${style} pool)`, () => {
  let engine: PostgresEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(DATABASE_URL, style));
  }, 120_000);
  afterAll(async () => { await close(); });

  test('the drain peaks at half the engine pool', async () => {
    const poolMax = engine.getPoolDiagnostics()?.poolMax;
    expect(typeof poolMax).toBe('number');
    if (style === 'instance') expect(poolMax).toBe(4);
    await seed(engine, 12);
    expect(await peak(engine, await embeddingDims(engine))).toBe(Math.min(20, Math.max(1, Math.floor(poolMax! / 2))));
  }, 120_000);
});
