/**
 * scripts/scale/watchdog.ts: the out-of-process phase watchdog ends a phase
 * whose main thread is blocked synchronously (as a PGLite WASM statement
 * blocks it) and names the phase, elapsed vs limit, the last progress line,
 * the X5 TODO and the override variable.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X5_TODO_TITLE, superviseScaleRun, watchdogLimitsMs, type WatchedPhase } from '../../scripts/scale/watchdog.ts';

const HOUR = 3_600_000;
const limits = (vectors: number): Record<WatchedPhase, number> => ({ import: HOUR, extract: HOUR, vectors, budgets: HOUR });

function fixture(body: string): { dir: string; script: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-scale-watchdog-'));
  const script = join(dir, 'child.ts');
  writeFileSync(script, body);
  return { dir, script };
}

describe('scale phase watchdog', () => {
  test('a phase blocking the main thread synchronously fails by name within limit + grace, and its home and process group are cleaned up', async () => {
    const { dir, script } = fixture(`
      import { spawn } from 'node:child_process';
      import { mkdirSync } from 'node:fs';
      const home = ${JSON.stringify(join(tmpdir(), 'unused'))}.replace('unused', 'gbrain-scale-watchdog-home-' + process.pid);
      mkdirSync(home, { recursive: true });
      const grandchild = spawn('sleep', ['60'], { stdio: 'ignore' });
      console.log('[scale] brain home: ' + home);
      console.log('[scale] grandchild: ' + grandchild.pid);
      console.log('[scale] phase vectors start');
      console.log('[scale] vectors batch 3/40: 500 pages in 12 ms');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    `);
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; }) as typeof process.stdout.write;
    let code: number;
    let diagnostic = '';
    const t = performance.now();
    try {
      code = await superviseScaleRun({
        command: [process.execPath, script], pages: 20_000, limits: limits(1500), reproduce: 'bun run test:scale -- --pages 20000',
        onDiagnostic: text => { diagnostic = text; },
      });
    } finally {
      process.stdout.write = write;
    }
    const elapsed = performance.now() - t;
    try {
      expect(code).toBe(1);
      expect(elapsed).toBeLessThan(1500 + 3000);
      expect(diagnostic).toContain('FAIL phase watchdog: vectors ran');
      expect(diagnostic).toContain('limit 2 s');
      expect(diagnostic).toContain('last progress line: [scale] vectors batch 3/40: 500 pages in 12 ms');
      expect(diagnostic).toContain(`TODOS.md "${X5_TODO_TITLE}" (X5)`);
      expect(readFileSync(join(import.meta.dir, '../../TODOS.md'), 'utf8')).toContain(X5_TODO_TITLE);
      expect(diagnostic).toContain('GBRAIN_SCALE_PHASE_LIMIT_MS_VECTORS=<ms>');
      expect(diagnostic).toContain('bun run test:scale -- --pages 20000');
      const output = lines.join('');
      const home = /\[scale\] brain home: (.+)/.exec(output)![1]!;
      expect(existsSync(home)).toBe(false);
      const grandchild = Number(/\[scale\] grandchild: (\d+)/.exec(output)![1]);
      await Bun.sleep(100);
      expect(() => process.kill(grandchild, 0)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a phase that finishes inside its limit passes the child exit code through and leaves its home alone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-scale-watchdog-keep-'));
    const { dir, script } = fixture(`
      console.log('[scale] brain home: ${home}');
      console.log('[scale] phase vectors start');
      console.log('[scale] phase vectors done in 1 ms');
      console.log('[scale] phase ops start');
      process.exit(7);
    `);
    try {
      expect(await superviseScaleRun({ command: [process.execPath, script], pages: 20_000, limits: limits(60_000), reproduce: 'r' })).toBe(7);
      expect(existsSync(home)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('limits are 1.5x the gate ceilings, and the override variable replaces one phase', () => {
    const at20k = watchdogLimitsMs(20_000, {});
    expect(at20k).toEqual({ import: 45 * 60_000, extract: 22.5 * 60_000, vectors: 11.25 * 60_000, budgets: 15 * 60_000 });
    expect(watchdogLimitsMs(20_000, { GBRAIN_SCALE_PHASE_LIMIT_MS_VECTORS: '5000' }).vectors).toBe(5000);
    expect(() => watchdogLimitsMs(20_000, { GBRAIN_SCALE_PHASE_LIMIT_MS_EXTRACT: 'soon' })).toThrow('GBRAIN_SCALE_PHASE_LIMIT_MS_EXTRACT must be a positive number');
  });
});
