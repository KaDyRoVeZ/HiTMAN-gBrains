/**
 * embed() banks provider-reported tokens into the BudgetTracker record.
 *
 * The AI SDK's embedMany DOES surface usage (`usage.tokens`), but the
 * gateway's embed spend record ignored it and always charged
 * `ceil(chars / chars_per_token)` flagged `estimated` — the "not surfaced by
 * the AI SDK shape" comment had gone stale. The char heuristic misprices any
 * batch whose token density differs from the recipe constant (dense unicode —
 * Vietnamese diacritics, CJK — tokenizes at a fraction of the assumed
 * chars-per-token, so real spend lands a multiple ABOVE the estimate; terse
 * ASCII lands below it).
 *
 * Pins (transport stubbed at the __setEmbedTransportForTests seam):
 *   - provider reports usage.tokens → the ledger row carries EXACTLY that
 *     count, cost_basis 'measured' (fails pre-fix: char estimate, 'estimated')
 *   - provider omits usage → chars-per-token fallback, cost_basis 'estimated'
 *     (unchanged behavior, pinned)
 *   - reported tokens accumulate across calls on the ledger row
 */

import { describe, test, expect, afterEach } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  embed,
  withBudgetTracker,
  __setEmbedTransportForTests,
} from '../src/core/ai/gateway.ts';
import { BudgetTracker } from '../src/core/budget/budget-tracker.ts';

const DIMS = 1024;

function configureVoyage() {
  configureGateway({
    embedding_model: 'voyage:voyage-4',
    embedding_dimensions: DIMS,
    env: { VOYAGE_API_KEY: 'sk-fake' },
  });
}

function stubTransport(opts: { tokens?: number }) {
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({
    embeddings: values.map(() => Array.from({ length: DIMS }, () => 0.1)),
    ...(opts.tokens !== undefined ? { usage: { tokens: opts.tokens } } : {}),
  })) as any);
}

function embedRow(tracker: BudgetTracker) {
  const rows = tracker.snapshot().models.filter(r => r.touchpoint === 'embedding');
  expect(rows.length).toBe(1);
  return rows[0];
}

afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('embed budget uses provider-reported usage.tokens', () => {
  test('reported usage is charged exactly, cost_basis measured', async () => {
    configureVoyage();
    // 40 chars of input; the char heuristic would charge a different number
    // than the provider's 137 for any plausible chars_per_token.
    stubTransport({ tokens: 137 });
    const tracker = new BudgetTracker({ label: 'embed-usage-test' });
    await withBudgetTracker(tracker, () => embed(['xin chào thế giới — đây là một câu dài']));
    const row = embedRow(tracker);
    expect(row.input_tokens).toBe(137);
    expect(row.cost_basis).toBe('measured');
  });

  test('missing usage falls back to the chars-per-token estimate, flagged estimated', async () => {
    configureVoyage();
    stubTransport({});
    const tracker = new BudgetTracker({ label: 'embed-estimate-test' });
    const text = 'a'.repeat(400);
    await withBudgetTracker(tracker, () => embed([text]));
    const row = embedRow(tracker);
    expect(row.cost_basis).toBe('estimated');
    expect(row.input_tokens).toBeGreaterThan(0); // heuristic, not provider truth
    expect(row.input_tokens).not.toBe(137);
  });

  test('reported tokens accumulate across calls', async () => {
    configureVoyage();
    stubTransport({ tokens: 50 });
    const tracker = new BudgetTracker({ label: 'embed-sum-test' });
    await withBudgetTracker(tracker, async () => {
      await embed(['first batch']);
      await embed(['second batch']);
    });
    const row = embedRow(tracker);
    expect(row.calls).toBe(2);
    expect(row.input_tokens).toBe(100);
    expect(row.cost_basis).toBe('measured');
  });
});
