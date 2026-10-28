import { expect } from 'bun:test';
import { toAgentError, type AgentEnvelope, type RenderContext } from '../../src/core/agent-output.ts';
import { funnelSites, isGenericSuggestion } from '../../scripts/check-agent-contract.ts';

/** The envelope a caller on `transport` sees for a thrown error (nothing preapproved). */
export function envelopeFor(error: unknown, transport: RenderContext['transport'] = 'cli', callable: readonly string[] = []): AgentEnvelope {
  const render: RenderContext = { transport, isCallable: tool => callable.includes(tool), preapproved: () => false };
  return toAgentError(error, { transport, render });
}

/** The error a refusal throws (sync or async), so the test can render it. */
export async function caught(run: () => unknown): Promise<unknown> {
  try { await run(); } catch (error) { return error; }
  throw new Error('expected a refusal, but the call succeeded');
}

/**
 * Every call site of a file-local suggestion funnel (scanner site list) names
 * its own next step: a literal suggestion on every branch, none of them empty
 * or a generic denylist phrase.
 */
export function expectFunnelSuggestions(file: string, funnel: string, atLeast: number): void {
  const sites = funnelSites([file]).filter(site => site.funnel === funnel);
  expect(sites.length).toBeGreaterThanOrEqual(atLeast);
  const weak = sites.filter(site => !site.texts?.length || site.texts.some(isGenericSuggestion)).map(site => `${site.file}:${site.line} ${site.expr}`);
  expect(weak).toEqual([]);
}
