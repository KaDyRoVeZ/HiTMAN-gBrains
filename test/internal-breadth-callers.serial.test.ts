/**
 * #5890 — every internal breadth caller of hybridSearch opts out of both
 * reader-facing trims (autocut + adaptive return) through the one shared
 * INTERNAL_BREADTH_SEARCH_OPTS object: think gather (both legs), brainstorm
 * close-set, grade-takes evidence, whoknows and enrich.
 *
 * Gather, grade-takes and whoknows are driven through their real entry
 * points with hybridSearch captured; brainstorm and enrich (whose entry
 * points need an LLM and a candidate pipeline) are pinned at the call site.
 *
 * Serial: mock.module (isolation guard R2).
 */

import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as realHybrid from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { INTERNAL_BREADTH_SEARCH_OPTS } from '../src/core/search/internal-breadth.ts';

const captured: Array<Record<string, unknown>> = [];

mock.module('../src/core/search/hybrid.ts', () => ({
  ...realHybrid,
  hybridSearch: async (_engine: unknown, _query: string, opts: Record<string, unknown>) => {
    captured.push(opts);
    return [];
  },
}));

const { runGather } = await import('../src/core/think/gather.ts');
const { defaultEvidenceRetriever } = await import('../src/core/cycle/grade-takes.ts');
const { findExperts } = await import('../src/commands/whoknows.ts');

const engineStub = {
  searchTakes: async () => [],
  listPages: async () => [],
} as unknown as BrainEngine;

function expectBreadth(opts: Record<string, unknown> | undefined) {
  expect(opts).toBeDefined();
  expect(opts!.autocut).toBe(false);
  expect(opts!.adaptiveReturn).toBe(false);
}

describe('internal breadth callers pass INTERNAL_BREADTH_SEARCH_OPTS (#5890)', () => {
  test('the shared object disables both reader-facing trims', () => {
    expect(INTERNAL_BREADTH_SEARCH_OPTS).toEqual({ autocut: false, adaptiveReturn: false });
    expect(Object.isFrozen(INTERNAL_BREADTH_SEARCH_OPTS)).toBe(true);
  });

  test('think gather, plain and temporal-window legs', async () => {
    captured.length = 0;
    await runGather(engineStub, { question: 'what changed in the payments migration' });
    await runGather(engineStub, {
      question: 'what changed last week',
      window: { startMs: Date.UTC(2026, 0, 1), endMs: Date.UTC(2026, 0, 8) },
    });
    expect(captured).toHaveLength(2);
    for (const opts of captured) expectBreadth(opts);
  });

  test('grade-takes evidence retriever', async () => {
    captured.length = 0;
    await defaultEvidenceRetriever(engineStub, { claim: 'Acme will ship in Q3', page_slug: 'people/alice-example' } as never, { sourceId: 'default' });
    expect(captured).toHaveLength(1);
    expectBreadth(captured[0]);
  });

  test('whoknows expert search', async () => {
    captured.length = 0;
    await findExperts(engineStub, { topic: 'payments infrastructure' });
    expect(captured).toHaveLength(1);
    expectBreadth(captured[0]);
  });

  test('brainstorm close-set and enrich spread the shared object into their hybridSearch call', () => {
    for (const rel of ['src/core/brainstorm/orchestrator.ts', 'src/commands/enrich.ts']) {
      const src = readFileSync(join(import.meta.dir, '..', rel), 'utf8');
      const calls = [...src.matchAll(/await hybridSearch\([^,]+,[^,]+,\s*\{([^}]*)\}/g)];
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call[1]).toContain('...INTERNAL_BREADTH_SEARCH_OPTS');
    }
  });
});
