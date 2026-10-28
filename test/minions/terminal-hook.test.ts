/**
 * #7242 terminal hook: an argv from local file-plane config, spawned without a shell, given the job in fixed
 * env vars and as JSON on stdin, killed at its timeout, its failures logged and never retried, never changing
 * the job. The worker runs it once per job it ran that reached a terminal status.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { UnrecoverableError, type MinionJob } from '../../src/core/minions/types.ts';
import { parseTerminalHook, resolveTerminalHook, runTerminalHook, terminalHookNotifier } from '../../src/core/minions/terminal-hook.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

function hookScript(body: string): { dir: string; argv: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-terminal-hook-'));
  const script = join(dir, 'hook.sh');
  writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { dir, argv: ['/bin/sh', script, dir] };
}
const RECORD = 'cat > "$1/$GBRAIN_JOB_ID.stdin.json"; printf "%s|%s|%s|%s" "$GBRAIN_JOB_ID" "$GBRAIN_JOB_NAME" "$GBRAIN_JOB_QUEUE" "$GBRAIN_JOB_STATUS" > "$1/$GBRAIN_JOB_ID.env"';

function fakeJob(over: Partial<MinionJob>): MinionJob {
  return { id: 7, name: 'noop', queue: 'default', status: 'completed', attempts_made: 1, parent_job_id: null,
    created_at: new Date('2026-10-21T00:00:00Z'), started_at: null, finished_at: new Date('2026-10-21T00:00:01Z'),
    error_text: null, data: { prompt: 'secret-example' }, result: { value: 'r' }, ...over } as MinionJob;
}

async function quiet<T>(fn: () => Promise<T>): Promise<{ value: T; warnings: string[] }> {
  const orig = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')); };
  try { return { value: await fn(), warnings }; } finally { console.warn = orig; }
}

describe('config', () => {
  test('only an argv array with an absolute command is accepted', () => {
    expect(parseTerminalHook('["/usr/local/bin/notify-job","--quiet"]')).toEqual({ argv: ['/usr/local/bin/notify-job', '--quiet'], timeout_ms: 10_000 });
    expect(parseTerminalHook({ argv: ['/bin/true'], timeout_ms: 500 })).toEqual({ argv: ['/bin/true'], timeout_ms: 500 });
    expect(() => parseTerminalHook('"notify-job $GBRAIN_JOB_ID"')).toThrow(/JSON array/);
    expect(() => parseTerminalHook('notify-job')).toThrow();
    expect(() => parseTerminalHook(['notify-job'])).toThrow(/absolute path/);
    expect(() => parseTerminalHook([])).toThrow(/JSON array/);
    expect(() => parseTerminalHook({ argv: ['/bin/true'], timeout_ms: 0 })).toThrow(/timeout_ms/);
  });

  test('off by default; read from the file-plane config object only', async () => {
    expect(resolveTerminalHook(null)).toBeNull();
    expect(resolveTerminalHook({ engine: 'pglite' } as never)).toBeNull();
    expect(resolveTerminalHook({ engine: 'pglite', minions: { terminal_hook: ['/bin/true'] } } as never)).toEqual({ argv: ['/bin/true'], timeout_ms: 10_000 });
    const { value, warnings } = await quiet(async () => resolveTerminalHook({ engine: 'pglite', minions: { terminal_hook: 'sh -c x' } } as never));
    expect(value).toBeNull();
    expect(warnings.join('\n')).toContain('terminal hook disabled');
  });
});

describe('runTerminalHook', () => {
  test('passes the job in fixed env vars and on stdin, never through a shell string', async () => {
    const { dir, argv } = hookScript(RECORD);
    const name = 'noop$(touch pwned-example)';
    const outcome = await runTerminalHook({ argv, timeout_ms: 5_000 }, fakeJob({ id: 41, name, status: 'failed', error_text: 'boom-example' }));
    expect(outcome).toBe('ok');
    expect(readFileSync(join(dir, '41.env'), 'utf8')).toBe(`41|${name}|default|failed`);
    const payload = JSON.parse(readFileSync(join(dir, '41.stdin.json'), 'utf8'));
    expect(Object.keys(payload).sort()).toEqual(['attempts_made', 'created_at', 'error_text', 'finished_at', 'id', 'name', 'parent_job_id', 'queue', 'started_at', 'status']);
    expect(payload).toMatchObject({ id: 41, status: 'failed', error_text: 'boom-example', finished_at: '2026-10-21T00:00:01.000Z' });
    expect(JSON.stringify(payload)).not.toContain('secret-example');
    expect(existsSync(join(dir, 'pwned-example'))).toBe(false);
    expect(existsSync('pwned-example')).toBe(false);
  });

  test('a hook past its timeout is killed and logged; a nonzero exit is logged; neither throws', async () => {
    const slow = hookScript('sleep 5');
    const started = Date.now();
    const t = await quiet(() => runTerminalHook({ argv: slow.argv, timeout_ms: 200 }, fakeJob({})));
    expect(t.value).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(t.warnings.join('\n')).toContain('timeout');
    const failing = hookScript('echo nope-example >&2; exit 3');
    const f = await quiet(() => runTerminalHook({ argv: failing.argv, timeout_ms: 5_000 }, fakeJob({})));
    expect(f.value).toBe('exit_nonzero');
    expect(f.warnings.join('\n')).toContain('exit 3');
    expect(f.warnings.join('\n')).toContain('nope-example');
    const missing = await quiet(() => runTerminalHook({ argv: ['/nonexistent/hook-example'], timeout_ms: 5_000 }, fakeJob({})));
    expect(missing.value).toBe('spawn_error');
  });
});

describe('worker wiring', () => {
  test('the worker runs the hook once per terminal job it ran, and never for a job going back to the queue', async () => {
    const { dir, argv } = hookScript(RECORD);
    const queue = new MinionQueue(engine);
    const ok = await queue.add('hook-ok', { n: 1 });
    const dead = await queue.add('hook-dead', { n: 2 });
    const retry = await queue.add('hook-retry', { n: 3 }, { max_attempts: 3, backoff_delay: 60_000, backoff_type: 'fixed' });
    const notifier = terminalHookNotifier(engine, { argv, timeout_ms: 5_000 });
    const worker = new MinionWorker(engine, { pollInterval: 50, onJobSettled: notifier.onJobSettled });
    worker.register('hook-ok', async () => ({ fine: true }));
    worker.register('hook-dead', async () => { throw new UnrecoverableError('broken-example'); });
    worker.register('hook-retry', async () => { throw new Error('transient-example'); });
    const running = worker.start();
    for (let i = 0; i < 200; i++) {
      const rows = await Promise.all([ok, dead, retry].map(j => queue.getJob(j.id)));
      if (rows[0]?.status === 'completed' && rows[1]?.status === 'dead' && rows[2]?.status === 'delayed') break;
      await new Promise(r => setTimeout(r, 50));
    }
    worker.stop();
    await running;
    await notifier.drain();
    expect(readFileSync(join(dir, `${ok.id}.env`, ), 'utf8')).toBe(`${ok.id}|hook-ok|default|completed`);
    expect(readFileSync(join(dir, `${dead.id}.env`), 'utf8')).toBe(`${dead.id}|hook-dead|default|dead`);
    expect(existsSync(join(dir, `${retry.id}.env`))).toBe(false);
    expect(readdirSync(dir).filter(f => f.endsWith('.env')).length).toBe(2);
    expect((await queue.getJob(ok.id))!.status).toBe('completed');
  });
});
