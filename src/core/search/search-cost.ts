/**
 * Per-request model-call cost for `search` / `query` (`_meta.retrieval.cost`,
 * the CLI's `--timings` document). One meter per op call, scoped with
 * AsyncLocalStorage, so concurrent MCP requests never see each other's calls.
 *
 * Every embedding, rerank, query-expansion, chat and decide call inside the
 * request counts (expansion is its own line, the calls chat_usage_log
 * records with phase `expansion`),
 * failed ones included (a provider can bill a failed call); a call a budget
 * guard refused was never sent and does not count. Tokens are the provider's
 * reported usage; a call whose provider reported none counts its request
 * estimate and is tallied in `estimated_token_calls`. USD comes from the
 * shipped pricing tables (budget/reservation-cost.ts) and is present only
 * when every call of that kind is priced. Metering never changes a call.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { withAIInvocationMeter, type AIInvocationEvent } from '../ai/invocation-guard.ts';
import { usageCostUsd, type BudgetKind } from '../budget/reservation-cost.ts';

export type SearchCostKind = 'embedding' | 'rerank' | 'expansion' | 'chat' | 'decide';

export interface SearchCostLine {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  estimated_token_calls?: number;
  usd?: number;
}

export type SearchCostMeta = { calls: number; estimated_usd?: number } & Partial<Record<SearchCostKind, SearchCostLine>>;

const KIND: Record<AIInvocationEvent['call']['kind'], { line: SearchCostKind; budget: BudgetKind } | undefined> = {
  embedding: { line: 'embedding', budget: 'embed' },
  multimodal: { line: 'embedding', budget: 'embed' },
  rerank: { line: 'rerank', budget: 'rerank' },
  chat: { line: 'chat', budget: 'chat' },
  decide: { line: 'decide', budget: 'decide' },
  transcription: undefined,
};

type Tally = SearchCostLine & { usd: number; unpriced: boolean };

/** USD to the micro-dollar: one search costs fractions of a cent. */
const roundUsd = (usd: number): number => Math.round(usd * 1e6) / 1e6;

class SearchCost {
  private readonly tallies = new Map<SearchCostKind, Tally>();

  add(event: AIInvocationEvent): void {
    const kind = KIND[event.call.kind];
    if (!kind || event.outcome === 'refused') return;
    const line = event.call.operation === 'gateway.expand' ? 'expansion' : kind.line;
    const tally = this.tallies.get(line) ?? { calls: 0, input_tokens: 0, output_tokens: 0, usd: 0, unpriced: false };
    const input = event.usage?.inputTokens ?? event.call.estimatedInputTokens ?? 0;
    const output = event.usage?.outputTokens ?? 0;
    tally.calls += 1;
    tally.input_tokens += input;
    tally.output_tokens += output;
    if (!event.usage) tally.estimated_token_calls = (tally.estimated_token_calls ?? 0) + 1;
    const usd = usageCostUsd(event.call.model, input, output, kind.budget);
    if (usd === null) tally.unpriced = true;
    else tally.usd += usd;
    this.tallies.set(line, tally);
  }

  snapshot(): SearchCostMeta {
    const out: SearchCostMeta = { calls: 0 };
    let total = 0;
    let priced = true;
    for (const [kind, { usd, unpriced, ...line }] of this.tallies) {
      out.calls += line.calls;
      out[kind] = unpriced ? line : { ...line, usd: roundUsd(usd) };
      priced &&= !unpriced;
      total += usd;
    }
    if (priced) out.estimated_usd = roundUsd(total);
    return out;
  }
}

const current = new AsyncLocalStorage<SearchCost>();

/** Run one search/query request under its own cost meter. */
export function withSearchCost<T>(run: () => Promise<T>): Promise<T> {
  const cost = new SearchCost();
  return current.run(cost, () => withAIInvocationMeter(event => cost.add(event), run));
}

/** The current request's cost so far; undefined outside `withSearchCost` (internal searches). */
export function searchCostSnapshot(): SearchCostMeta | undefined {
  return current.getStore()?.snapshot();
}
