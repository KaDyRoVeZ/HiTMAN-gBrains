/**
 * Out-of-process phase watchdog for the scale harness (A6/X5; ENG-2, DX-13).
 *
 * scripts/scale/run.ts re-runs itself as a child under this supervisor. A
 * PGLite statement runs synchronously inside WASM on the child's main thread,
 * so an in-process timer cannot fire during a stall; the parent reads the
 * child's `[scale] phase <name> start` lines, times each watched phase, and
 * SIGKILLs the child's process group at the limit. The diagnostic names the
 * phase, elapsed vs limit, the last progress line, the X5 TODO and the
 * override variable, then the supervisor removes the child's brain home and
 * scale database (the killed child cannot run its own cleanup).
 *
 * Watched phases and the child phases they cover:
 *   import   corpus, schema, import_files, extract, vectors (the gate's import window)
 *   extract  extract
 *   vectors  vectors
 *   budgets  ops, reimport, cold_query, writers (the gate's budgets window)
 * Limits are 1.5x the gate ceilings (scripts/scale/gates.ts phaseLimitsMs), so
 * the gate stays the verdict and the watchdog only ends hangs. Override one
 * with GBRAIN_SCALE_PHASE_LIMIT_MS_<PHASE> (e.g. ..._VECTORS=3600000) for a
 * local investigation.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { phaseLimitsMs } from './gates.ts';

export type WatchedPhase = 'import' | 'extract' | 'vectors' | 'budgets';
export const WATCHED_PHASES: WatchedPhase[] = ['import', 'extract', 'vectors', 'budgets'];
const COVERS: Record<string, WatchedPhase[]> = {
  corpus: ['import'], schema: ['import'], import_files: ['import'],
  extract: ['import', 'extract'], vectors: ['import', 'vectors'],
  ops: ['budgets'], reimport: ['budgets'], cold_query: ['budgets'], writers: ['budgets'],
};
export const WATCHDOG_GRACE = 1.5;
export const X5_TODO_TITLE = 'PGLite bulk-embedding cost at 20k+ chunks';
export const X5_TODO = `TODOS.md "${X5_TODO_TITLE}" (X5)`;
export const HOME_LINE = '[scale] brain home: ';
export const DATABASE_LINE = '[scale] scale database: ';

export const overrideVariable = (phase: WatchedPhase) => `GBRAIN_SCALE_PHASE_LIMIT_MS_${phase.toUpperCase()}`;

export function watchdogLimitsMs(pages: number, env: Record<string, string | undefined> = process.env): Record<WatchedPhase, number> {
  const gate = phaseLimitsMs(pages);
  const limits: Record<WatchedPhase, number> = {
    import: gate.import * WATCHDOG_GRACE,
    extract: gate.import * 0.5 * WATCHDOG_GRACE,
    vectors: gate.import * 0.25 * WATCHDOG_GRACE,
    budgets: gate.budgets * WATCHDOG_GRACE,
  };
  for (const phase of WATCHED_PHASES) {
    const raw = env[overrideVariable(phase)];
    if (raw === undefined || raw === '') continue;
    const ms = Number(raw);
    if (!Number.isFinite(ms) || ms <= 0) throw new Error(`${overrideVariable(phase)} must be a positive number of milliseconds, got '${raw}'.`);
    limits[phase] = ms;
  }
  return limits;
}

export function watchdogDiagnostic(phase: WatchedPhase, elapsedMs: number, limitMs: number, lastLine: string, reproduce: string): string {
  return [
    `[scale] FAIL phase watchdog: ${phase} ran ${Math.round(elapsedMs / 1000)} s, limit ${Math.round(limitMs / 1000)} s; the harness was killed (exit 1).`,
    `[scale]   last progress line: ${lastLine || '(none)'}`,
    `[scale]   Why: a phase past its watchdog limit (${WATCHDOG_GRACE}x its gate ceiling unless overridden) is a stall, and an in-process timer cannot fire while PGLite blocks the main thread.`,
    `[scale]   Known issue: ${X5_TODO} tracks PGLite bulk-embedding cost and the 20k vectors stall history.`,
    `[scale]   Fix: profile the named phase; to let it run longer locally, set ${overrideVariable(phase)}=<ms> and rerun: ${reproduce}`,
  ].join('\n');
}

export interface SuperviseOptions {
  command: string[];
  pages: number;
  reproduce: string;
  env?: Record<string, string | undefined>;
  limits?: Record<WatchedPhase, number>;
  /** Drops the child's scale database after a kill; run.ts passes a Postgres admin connection. */
  dropDatabase?: (name: string) => Promise<void>;
  onDiagnostic?: (text: string) => void;
}

/** Run the harness child under the watchdog; resolves to the exit code to use. */
export async function superviseScaleRun(opts: SuperviseOptions): Promise<number> {
  const limits = opts.limits ?? watchdogLimitsMs(opts.pages, opts.env);
  const child = spawn(opts.command[0]!, opts.command.slice(1), {
    env: { ...(opts.env ?? process.env), GBRAIN_SCALE_SUPERVISED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  const started = new Map<WatchedPhase, number>();
  let lastLine = '';
  let home: string | undefined;
  let database: string | undefined;
  let fired: string | undefined;

  const consume = (stream: NodeJS.ReadableStream, sink: NodeJS.WriteStream) => {
    let buffered = '';
    stream.on('data', (chunk: Buffer) => {
      sink.write(chunk);
      buffered += chunk.toString();
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? '';
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        lastLine = line.slice(0, 500);
        if (line.startsWith(HOME_LINE)) home = line.slice(HOME_LINE.length);
        if (line.startsWith(DATABASE_LINE)) database = line.slice(DATABASE_LINE.length);
        const phase = /^\[scale\] phase (\w+) start$/.exec(line)?.[1];
        const now = performance.now();
        for (const p of WATCHED_PHASES) if (started.has(p) && !(COVERS[phase ?? '']?.includes(p) ?? true)) started.delete(p);
        for (const p of COVERS[phase ?? ''] ?? []) if (!started.has(p)) started.set(p, now);
      }
    });
  };
  consume(child.stdout!, process.stdout);
  consume(child.stderr!, process.stderr);

  const exited = new Promise<number>(resolve => child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 3))));
  const timer = setInterval(() => {
    if (fired) return;
    const now = performance.now();
    for (const [phase, since] of started) {
      if (now - since <= limits[phase]) continue;
      fired = watchdogDiagnostic(phase, now - since, limits[phase], lastLine, opts.reproduce);
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      return;
    }
  }, 250);
  const code = await exited;
  clearInterval(timer);
  if (!fired) return code;
  console.log(fired);
  opts.onDiagnostic?.(fired);
  if (home) rmSync(home, { recursive: true, force: true });
  if (database && opts.dropDatabase) {
    await opts.dropDatabase(database).catch(e => console.log(`[scale] could not drop ${database}: ${e instanceof Error ? e.message : String(e)}; drop it by hand with DROP DATABASE ${database} WITH (FORCE)`));
  }
  return 1;
}
