/**
 * Spend refusals across the process-isolation boundary and the child
 * capability gate.
 *
 * Protects: a group refusal keeps its code, fix and group amounts through the
 * child outcome codec; pressure keeps its retry delay; both abort a worker
 * pool; a parent never hands a spend-authorized row to a child executor that
 * did not advertise `spend-enforcement-v1` (the row is released through the
 * lease path, not failed), while such a child still passes readiness for
 * every other row.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { encodeHandlerError, parseChildOutcome, reconstructHandlerError } from '../src/core/minions/job-isolation.ts';
import { CHILD_READINESS_FEATURES, parseChildReadiness } from '../src/core/minions/child-readiness.ts';
import { runJobInChild } from '../src/core/minions/child-job-runner.ts';
import { RateLeaseUnavailableError } from '../src/core/minions/rate-leases.ts';
import { isMustAbortError } from '../src/core/worker-pool.ts';
import {
  SpendEnforcementUnavailableError, SpendGroupPressureError, SpendGroupRefusedError, noteChildSpendEnforcement,
  type SpendRefusalEnvelope,
} from '../src/core/minions/spend-authorization.ts';
import { VERSION } from '../src/version.ts';

afterEach(() => noteChildSpendEnforcement([...CHILD_READINESS_FEATURES]));

const envelope = {
  error: 'derived_cap_exhausted', code: 'derived_cap_exhausted', message: 'Job 7 (book-mirror) stopped.',
  suggestion: 'Ask the user.', fix: { argv: ['gbrain', 'book-mirror', '--max-usd', '20.00', '--yes'], consent: ['paid'], actor: 'agent', why: 'resume', requires_exclusive: false },
  contract_version: 1,
  group: { group_id: '0192a000-0000-7000-8000-000000000002', cap_usd: 10, cap_source: 'derived', spent_usd: 10, overdue_usd: 0, reserved_usd: 0, remaining_usd: 0 },
} as unknown as SpendRefusalEnvelope;

function roundTrip(err: unknown): Error {
  const raw = JSON.stringify(encodeHandlerError(err));
  const decoded = parseChildOutcome(raw, raw.length);
  if (decoded.outcome !== 'error') throw new Error('expected an error outcome');
  return reconstructHandlerError(decoded);
}

describe('child outcome codec', () => {
  test('a group refusal keeps its code, fix and group amounts', () => {
    const back = roundTrip(new SpendGroupRefusedError(envelope));
    expect(back).toBeInstanceOf(SpendGroupRefusedError);
    expect((back as SpendGroupRefusedError).envelope).toEqual(envelope);
    expect(back.message).toBe('derived_cap_exhausted: Job 7 (book-mirror) stopped.');
  });

  test('pressure keeps its retry delay and still releases through the lease path', () => {
    const back = roundTrip(new SpendGroupPressureError('group:0192a000-0000-7000-8000-000000000002', 800, 1000));
    expect(back).toBeInstanceOf(RateLeaseUnavailableError);
    expect((back as RateLeaseUnavailableError).retryInMs).toBeGreaterThan(0);
  });

  test('group refusals abort a worker pool', () => {
    expect(isMustAbortError(new SpendGroupRefusedError(envelope))).toBe(true);
    expect(isMustAbortError(new SpendGroupPressureError('group:x', 1, 2))).toBe(true);
  });
});

describe('child spend-enforcement capability', () => {
  const oldChild = JSON.stringify({ protocolVersion: 1, version: VERSION, status: 'ready',
    features: ['local-configuration-outcome-v1', 'postgres-cancellation-v1'] });

  test('a child without the feature passes readiness and is recorded as unable to enforce', () => {
    const parsed = parseChildReadiness(oldChild);
    expect(parsed.features).not.toContain('spend-enforcement-v1');
    noteChildSpendEnforcement(parsed.features);
    const run = runJobInChild({
      jobId: 1, spendAuthorized: true, jobName: 'subagent', lockToken: 't',
      abortSignal: new AbortController().signal, shutdownSignal: new AbortController().signal,
      invocation: { cmd: '/nonexistent/gbrain', argsPrefix: [] }, tiniPath: '',
    });
    return expect(run).rejects.toBeInstanceOf(SpendEnforcementUnavailableError);
  });

  test('the release error is a lease release, so no attempt is burned', () => {
    expect(new SpendEnforcementUnavailableError()).toBeInstanceOf(RateLeaseUnavailableError);
  });
});
