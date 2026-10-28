import { describe, expect, test } from 'bun:test';
import { parseReindexCodeDelegateArgs } from '../src/commands/reindex-code-delegate.ts';
import { caught, envelopeFor, expectFunnelSuggestions } from './helpers/agent-envelope.ts';

describe('resident code reindex arguments', () => {
  test('keyless source-scoped recovery stays explicit', () => {
    expect(parseReindexCodeDelegateArgs(['--source', 'code-example', '--force', '--no-embed', '--json'])).toEqual({
      sourceId: 'code-example', force: true, noEmbed: true, json: true,
    });
  });

  test('unknown argument values never appear in errors', () => {
    try {
      parseReindexCodeDelegateArgs(['--token=synthetic-credential-value']);
      throw new Error('Expected refusal');
    } catch (error) {
      expect(error).toMatchObject({ code: 'invalid_params' });
      expect((error as Error).message).not.toContain('synthetic-credential-value');
      expect(JSON.stringify(envelopeFor(error))).not.toContain('synthetic-credential-value');
    }
  });

  for (const args of [['--workers', '0'], ['--workers', '65'], ['--max-cost', '0'], ['--source']]) {
    test(`invalid recovery options are refused: ${args.join(' ')}`, () => {
      expect(() => parseReindexCodeDelegateArgs(args)).toThrow();
    });
  }

  test('refusals name the flag usage and offer the reindex-code help', async () => {
    expectFunnelSuggestions('src/commands/reindex-code-delegate.ts', 'invalid', 4);
    const env = envelopeFor(await caught(() => parseReindexCodeDelegateArgs(['--workers', '65'])));
    expect(env).toMatchObject({ code: 'invalid_params', fix: { argv: ['gbrain', 'reindex-code', '--help'], next: 'run' } });
    expect(env.suggestion).toContain('--workers 4');
  });
});
