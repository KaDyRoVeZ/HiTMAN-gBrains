import { afterAll, beforeAll, expect, test } from 'bun:test';
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { persistenceHome, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-stdio-registration-'));
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('a stdio registration that resolves to the CLI lane names the agent-facing registration the user creates', () => withEnv({ GBRAIN_HOME: home }, async () => {
  await registerLocalWriter(engine, 'cli');
  const cli = readdirSync(persistenceHome()).find(name => name.endsWith('.cli.json'))!;
  copyFileSync(join(persistenceHome(), cli), join(persistenceHome(), cli.replace('.cli.json', '.stdio.json')));
  const result = await dispatchToolCall(engine, 'list_skills', {}, { remote: true, transport: 'stdio', sourceId: 'default' });
  expect(result.isError).toBe(true);
  const envelope = JSON.parse(result.content[0]!.text);
  expect(envelope).toMatchObject({ code: 'permission_denied', fix: { actor: 'user', next: 'tell_user_to_run' } });
  expect(envelope.fix.argv.slice(0, 7)).toEqual(['gbrain', 'auth', 'local-writer', 'register', 'stdio', '--dry-run', '--json']);
  expect(envelope.suggestion).toContain('list_skills on this stdio connection');
}));
