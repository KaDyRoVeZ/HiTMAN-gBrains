/**
 * The warm CLI socket is opt-in (docs/guides/cli-socket.md). A serve that leaves it off must boot as it did before the
 * socket existed: it loads nothing under src/core/cli-socket/ and makes no engine call for it. A serve that asks for it
 * (`--cli-socket`, or `serve_cli_socket` in the config merge connectEngine published) loads it once its boot is done.
 *
 * Each boot runs in its own bun process, so a module another test file in this shard already loaded cannot hide an
 * import, and the counting engine records every method the serve calls on it. The socket refuses a non-Postgres engine
 * before touching it, so a boot with the socket off must make exactly the engine calls of a boot with `--cli-socket`.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

interface Boot { calls: string[]; modules: string[]; logs: string[] }

const CHILD = `
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
import { runServe } from './src/commands/serve.ts';
const { args, published, out } = JSON.parse(process.env.BOOT_SPEC);
const calls = [];
const engine = {
  getConfig: async (key) => { calls.push('getConfig(' + key + ')'); return null; },
  getAllConfig: async () => { calls.push('getAllConfig()'); return {}; },
  disconnect: async () => { calls.push('disconnect()'); },
};
if (published) (await import('./src/core/config.ts')).MERGED_CONFIG_BY_ENGINE.set(engine, { engine: 'postgres', serve_cli_socket: true });
const logs = [];
await runServe(engine, args, {
  stdin: new EventEmitter(), signals: { on() { return this; } }, exit: () => {}, log: line => { logs.push(line); },
  startMcpServer: async () => {}, getParentPid: () => 1, setInterval: () => 0, clearInterval: () => {},
  probeWatchdog: () => false, sweepEnabled: false,
});
await new Promise(resolve => setTimeout(resolve, 300));
const modules = Object.keys(require.cache).filter(path => path.includes('/src/core/cli-socket/'));
writeFileSync(out, JSON.stringify({ calls, modules, logs }));
process.exit(0);
`;

async function boot(args: string[], published = false): Promise<Boot> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-serve-socket-off-'));
  try {
    const out = join(home, 'boot.json');
    const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: home, GBRAIN_SWEEP: '0', BOOT_SPEC: JSON.stringify({ args, published, out }) };
    const proc = Bun.spawn(['bun', '--no-env-file', '-e', CHILD], { cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe' });
    const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    expect({ exitCode, stderr: exitCode === 0 ? '' : stderr }).toEqual({ exitCode: 0, stderr: '' });
    return JSON.parse(readFileSync(out, 'utf8')) as Boot;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('serve with the warm CLI socket off', () => {
  test('loads no cli-socket module and makes no engine call for it', async () => {
    const [off, on] = await Promise.all([boot([]), boot(['--cli-socket'])]);
    expect(off.modules).toEqual([]);
    expect(off.calls.toSorted()).toEqual(on.calls.toSorted());
    expect(off.calls).not.toContain('getConfig(serve.cli_socket)');
    expect(off.logs.filter(line => line.includes('cli-socket'))).toEqual([]);
  }, 60_000);

  test('--cli-socket loads it after the boot (the control: the probe sees an import)', async () => {
    const on = await boot(['--cli-socket']);
    expect(on.modules.some(path => path.endsWith('/cli-socket/server.ts'))).toBe(true);
    expect(on.logs.some(line => line.includes('cli-socket: not started'))).toBe(true);
    expect(on.calls).not.toContain('getConfig(serve.cli_socket)');
  }, 60_000);

  test('serve_cli_socket in the published config merge turns it on with no config read of its own', async () => {
    const on = await boot([], true);
    expect(on.modules.some(path => path.endsWith('/cli-socket/server.ts'))).toBe(true);
    expect(on.logs.some(line => line.includes('cli-socket: not started'))).toBe(true);
    expect(on.calls).not.toContain('getConfig(serve.cli_socket)');
  }, 60_000);
});
