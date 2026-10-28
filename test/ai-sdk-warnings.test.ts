/**
 * #5892: AI SDK provider warnings never reach stdout.
 *
 * Protects: loading the gateway installs a `globalThis.AI_SDK_LOG_WARNINGS`
 * writer with the installed `ai` logger signature (`{ warnings, provider,
 * model }`) that prints each warning to stderr and no stdout banner, for the
 * claude-cli provider (v2 compatibility notice) and the Anthropic provider
 * (`@ai-sdk/anthropic` "unsupported setting"); a value the user set is kept.
 * Regression: the `ai` default logger's `console.info` banner on stdout,
 * which broke `--json` output, or clobbering a user's `false`.
 * Existing coverage: none at this boundary; the CLI-level check lives in
 * test/json-stdout-ai-warnings.test.ts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import '../src/core/ai/gateway.ts';
import { ClaudeCliLanguageModel } from '../src/core/ai/providers/claude-cli-language-model.ts';
import { withEnv } from './helpers/with-env.ts';

const stubDir = join(tmpdir(), `gbrain-ai-sdk-warnings-${process.pid}`);
const stubBin = join(stubDir, 'claude');

beforeAll(() => {
  mkdirSync(stubDir, { recursive: true });
  const envelope = { type: 'result', subtype: 'success', is_error: false, result: 'ok', stop_reason: 'end_turn', session_id: 's', num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 } };
  writeFileSync(stubBin, `#!/bin/sh\ncat > /dev/null\necho '${JSON.stringify(envelope)}'\n`);
  chmodSync(stubBin, 0o755);
});
afterAll(() => rmSync(stubDir, { recursive: true, force: true }));

const original = globalThis.AI_SDK_LOG_WARNINGS;
afterEach(() => { globalThis.AI_SDK_LOG_WARNINGS = original; });

async function captureOutput(fn: () => Promise<unknown>): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const spies = [
    spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true; }) as never),
    spyOn(console, 'info').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); }),
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); }),
    spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { err.push(`console.warn ${a.join(' ')}`); }),
    spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => { err.push(String(chunk)); return true; }) as never),
  ];
  try {
    await fn();
  } finally {
    for (const s of spies) s.mockRestore();
  }
  return { stdout: out.join(''), stderr: err.join('') };
}

describe('AI SDK warnings (#5892)', () => {
  test('loading the gateway installs the stderr writer', () => {
    expect(typeof original).toBe('function');
  });

  test('claude-cli: the v2 compatibility warning goes to stderr, no stdout banner', async () => {
    const { stdout, stderr } = await withEnv({ GBRAIN_CLAUDE_CLI_BIN: stubBin }, () =>
      captureOutput(() => generateText({ model: new ClaudeCliLanguageModel('claude-opus-5-5') as never, prompt: 'hi' })));
    expect(stdout).toBe('');
    expect(stderr).toContain('AI SDK Warning (claude-cli / claude-opus-5-5): The feature "specificationVersion" is used in a compatibility mode. Using v2 specification compatibility mode.');
    expect(stderr).not.toContain('console.warn');
  });

  test('anthropic: an unsupported-setting warning goes to stderr, no stdout banner', async () => {
    const anthropic = createAnthropic({
      apiKey: 'test-key',
      fetch: (async () => new Response(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test',
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch,
    });
    const { stdout, stderr } = await captureOutput(() => generateText({ model: anthropic('claude-test'), prompt: 'hi', seed: 7 }));
    expect(stdout).toBe('');
    expect(stderr).toContain('AI SDK Warning (anthropic.messages / claude-test): The feature "seed" is not supported.');
    expect(stderr).not.toContain('console.warn');
  });

  test('a user-set value is kept: false stays false, a function stays theirs', async () => {
    // Imported here, not at the top: a static import would install the writer
    // itself and hide a gateway that stopped loading it.
    const { installAiSdkWarningWriter, writeAiSdkWarningsToStderr } = await import('../src/core/ai/sdk-warnings.ts');
    expect(original).toBe(writeAiSdkWarningsToStderr);
    globalThis.AI_SDK_LOG_WARNINGS = false;
    installAiSdkWarningWriter();
    expect(globalThis.AI_SDK_LOG_WARNINGS).toBe(false);
    const mine = () => {};
    globalThis.AI_SDK_LOG_WARNINGS = mine;
    installAiSdkWarningWriter();
    expect(globalThis.AI_SDK_LOG_WARNINGS).toBe(mine);
    globalThis.AI_SDK_LOG_WARNINGS = undefined;
    installAiSdkWarningWriter();
    expect(globalThis.AI_SDK_LOG_WARNINGS as unknown).toBe(writeAiSdkWarningsToStderr);
  });
});
