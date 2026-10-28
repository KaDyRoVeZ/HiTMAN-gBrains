/**
 * #5919, end to end on the keyword path (hermetic PGLite, no embedding
 * provider, the `query` op's retrieval meta): a fixture shaped like the
 * gbrain-evals A4 world. Every question below reaches only the OR-relaxed
 * keyword fallback. Answerable questions, whose answer row matches all but
 * one framing word ("city", "many"), grade moderate; a missing attribute, a
 * sibling company's attribute and an absent company grade weak.
 *
 * Protects: the grade the query op reports for relaxed tops. Fails if the op
 * stops passing the query text to the grader, or if corroboration accepts
 * split or absent evidence. crag.test.ts covers the pure rule; this covers
 * real fallback rows and the op wiring.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';
import { resetGateway } from '../../src/core/ai/gateway.ts';
import { operationsByName } from '../../src/core/operations.ts';
import type { OperationContext } from '../../src/core/operations.ts';
import type { CragMetaBlock } from '../../src/core/search/crag.ts';

let engine: PGLiteEngine;

const PAGES = [
  ['companies/vessra-example', 'company', 'Vessra Example', 'Vessra Example is a fictional company. Vessra Example is headquartered in Dunmere. Vessra Example was founded in April 1987.'],
  ['notes/a4-vessra-example-runway', 'note', 'Diligence note: Vessra Example', 'Diligence note on Vessra Example. Vessra Example has 31 months of runway at current burn. The remaining questions go to the next partner meeting.'],
  ['companies/orlak-example', 'company', 'Orlak Example', 'Orlak Example is a fictional company. Orlak Example has 140 employees. Orlak Example was founded in May 1990.'],
  ['companies/tamsk-labs-example', 'company', 'Tamsk Labs Example', 'Tamsk Labs Example is a fictional company. Tamsk Labs Example has 52 months of runway at current burn.'],
  ['companies/tamsk-freight-example', 'company', 'Tamsk Freight Example', 'Tamsk Freight Example is a fictional company. Tamsk Freight Example is headquartered in Elmira.'],
  ['companies/brisk-example', 'company', 'Brisk Example', 'Brisk Example is a fictional company. Brisk Example is headquartered in Ostrel. Brisk Example has 18 months of runway at current burn.'],
] as const;

beforeAll(async () => {
  resetGateway();
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const [slug, type, title, text] of PAGES) {
    await engine.putPage(slug, { type, title, compiled_truth: text, timeline: '' });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: text }]);
  }
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  resetGateway();
});

async function grade(query: string): Promise<{ crag: CragMetaBlock; slugs: string[] }> {
  const meta: Record<string, unknown> = {};
  const ctx = {
    engine, remote: false, sourceId: 'default',
    emitResponseMeta: (key: string, value: unknown) => { meta[key] = value; },
  } as unknown as OperationContext;
  const results = await operationsByName.query.handler(ctx, { query, expand: false, limit: 5 }) as Array<{ slug: string; keyword_relaxed?: boolean }>;
  expect(results[0]?.keyword_relaxed).toBe(true);
  return { crag: (meta.retrieval as { crag: CragMetaBlock }).crag, slugs: results.map(r => r.slug) };
}

describe('#5919: A4-style relaxed tops through the query op', () => {
  test('answerable, answer on the profile page → moderate', async () => {
    const { crag, slugs } = await grade('Which city is Vessra Example headquartered in?');
    expect(slugs).toContain('companies/vessra-example');
    expect(crag).toMatchObject({ confidence: 'moderate', reason: 'keyword_relaxed_corroborated' });
  });

  test('answerable, answer only in a diligence note → moderate', async () => {
    const { crag, slugs } = await grade('How many months of runway does Vessra Example have?');
    expect(slugs).toContain('notes/a4-vessra-example-runway');
    expect(crag).toMatchObject({ confidence: 'moderate', reason: 'keyword_relaxed_corroborated' });
  });

  test('missing attribute: the company exists, the attribute is written only for others → weak', async () => {
    const { crag } = await grade('Which city is Orlak Example headquartered in?');
    expect(crag).toMatchObject({ confidence: 'weak', reason: 'keyword_relaxed_top' });
  });

  test('sibling attribute: a company sharing the head word has it → weak', async () => {
    const { crag } = await grade('Which city is Tamsk Labs Example headquartered in?');
    expect(crag).toMatchObject({ confidence: 'weak', reason: 'keyword_relaxed_top' });
  });

  test('absent entity: no page names the company → weak', async () => {
    const { crag } = await grade('How many months of runway does Corvane Example have?');
    expect(crag).toMatchObject({ confidence: 'weak', reason: 'keyword_relaxed_top' });
  });
});
