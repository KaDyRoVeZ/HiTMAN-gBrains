import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { assertToolWriteCommitted } from '../src/core/minions/tool-write-identity.ts';
import { envelopeFor } from './helpers/agent-envelope.ts';

const receipt = (state: string) => ({ request_id: randomUUID(), state, retry_after_ms: null });
const refusal = (state: string) => { try { assertToolWriteCommitted(receipt(state), 'brain_put_page'); } catch (error) { return error; } throw new Error('accepted'); };

describe('subagent tool writes that did not commit point at their durable receipt', () => {
  test('a pending tool write reads its receipt and never repeats the call', () => {
    const error = refusal('queued') as { writeRequest: { request_id: string } };
    const env = envelopeFor(error);
    expect(env).toMatchObject({ code: 'write_pending', fix: { argv: ['gbrain', 'write-request', '--', error.writeRequest.request_id], next: 'run' } });
    expect(env.suggestion).toContain('Do not repeat the tool call');
  });

  test('a failed tool write reads the recorded error before any new write', () => {
    expect(envelopeFor(refusal('failed')).suggestion).toContain('new request id');
  });
});
