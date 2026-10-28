/**
 * GBRA-156: `gbrain sources add` warns when the new source is not federated.
 *
 * 1. Protects: a new source is not federated unless --federated is passed, so
 *    a remote token with no source grant (and an unbound agent connection)
 *    never reads its pages, and its searches answer empty. The stored default
 *    stays non-federated; the command now says what that means on stderr,
 *    with the two commands that change it.
 * 2. Fails when: the default add prints no warning, the warning lacks the
 *    federate or grant command, a --federated or explicit --no-federated add
 *    warns, or the stored default flips to federated.
 * 3. Existing coverage: the stdout `federated: false` line only.
 * 4. No production seam: the real command on PGLite, console spies only.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSources } from '../src/commands/sources.ts';

let engine: PGLiteEngine;
const dirs: string[] = [];

async function add(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-sources-add-warn-'));
  dirs.push(dir);
  const out: string[] = [];
  const err: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  const warn = spyOn(console, 'error').mockImplementation((...a: unknown[]) => { err.push(a.join(' ')); });
  try {
    await runSources(engine, ['add', args[0]!, '--path', dir, '--force', ...args.slice(1)]);
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }
  return { stdout: out.join('\n'), stderr: err.join('\n') };
}

async function federated(id: string): Promise<unknown> {
  const rows = await engine.executeRaw<{ f: unknown }>(`SELECT config->'federated' AS f FROM sources WHERE id = $1`, [id]);
  return rows[0]?.f ?? null;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine?.disconnect();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('sources add federation warning', () => {
  test('the default add warns on stderr and names both remedies; the stored default stays non-federated', async () => {
    const { stdout, stderr } = await add(['source-a']);
    expect(stdout).toContain('federated: false');
    expect(stderr).toContain('source "source-a" is not federated');
    expect(stderr).toContain('no source grant');
    expect(stderr).toContain('gbrain sources federate source-a');
    expect(stderr).toContain('gbrain auth rescope --token <name> --sources source-a');
    expect(await federated('source-a')).not.toBe(true);
  });

  test('--federated adds without the warning', async () => {
    const { stderr } = await add(['source-b', '--federated']);
    expect(stderr).not.toContain('is not federated');
    expect(await federated('source-b')).toBe(true);
  });

  test('an explicit --no-federated add is the operator\'s stated choice and does not warn', async () => {
    const { stdout, stderr } = await add(['source-c', '--no-federated']);
    expect(stdout).toContain('federated: false');
    expect(stderr).not.toContain('is not federated');
  });
});
