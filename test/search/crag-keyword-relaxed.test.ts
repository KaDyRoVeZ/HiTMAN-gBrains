/**
 * gbrain-evals A4-2, end to end on the keyword path (hermetic PGLite, no
 * embedding provider): a question about a company no page names only
 * reaches the OR-relaxed fallback, and CRAG must grade that weak instead of
 * moderate. A question the corpus answers strictly stays moderate.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { resetGateway } from '../../src/core/ai/gateway.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import { gradeRetrievalConfidence } from '../../src/core/search/crag.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  resetGateway();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [slug, title, text] of [
    ['companies/talzarra-example', 'Talzarra Example', 'Talzarra Example headcount is 41 people. The company sells payroll software.'],
    ['companies/kelvane-example', 'Kelvane Example', 'Kelvane Example has 18 months of runway and is headquartered in a coastal city.'],
  ] as const) {
    await engine.putPage(slug, { type: 'company', title, compiled_truth: text, timeline: '' });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: text }]);
  }
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

describe('A4-2: CRAG on the keyword path', () => {
  test('a question about an unnamed company reaches only relaxed rows and grades weak', async () => {
    const results = await hybridSearch(engine, 'What is the headcount of Morvane Example?', { limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].keyword_relaxed).toBe(true);
    expect(gradeRetrievalConfidence(results)).toMatchObject({ level: 'weak', reason: 'keyword_relaxed_top' });
  });

  test('a question the corpus matches strictly is not graded by the relaxed rule', async () => {
    const results = await hybridSearch(engine, 'Talzarra headcount', { limit: 5 });
    expect(results[0]?.slug).toBe('companies/talzarra-example');
    expect(results[0].keyword_relaxed).toBeUndefined();
    expect(gradeRetrievalConfidence(results).reason).not.toBe('keyword_relaxed_top');
  });
});
