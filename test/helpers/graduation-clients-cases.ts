/**
 * Shared by the graduation-clients*.test.ts suites (older released binaries in
 * graduation-clients.test.ts; serve processes and stale clients in
 * graduation-clients-serve.test.ts): fresh legacy cases, a stale client home
 * on this machine, and running a refusal's fix exactly as an agent would.
 */
import { expect } from 'bun:test';
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gbrain, REPO, TARGET_ENV, type GbrainResult } from './graduation-e2e.ts';
import { legacyCase, scratchRoot, type Case } from './graduation-scenarios.ts';

const cases: Case[] = [];
/** afterAll hook for every clients file: close each case's target and remove the scratch root. */
export async function closeCases(): Promise<void> {
  for (const c of cases) await c.target.close().catch(() => {});
  rmSync(scratchRoot, { recursive: true, force: true });
}

export async function fresh(name: string): Promise<Case> {
  const c = await legacyCase(name);
  cases.push(c);
  return c;
}

/** A second GBRAIN_HOME whose copied config still routes to the PGLite path (a stale client on this machine). */
export function staleHome(c: Case): string {
  const home = join(c.fx.dir, 'stale-home');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: c.fx.dataDir, embedding_disabled: true }, null, 2), { mode: 0o600 });
  return home;
}

/** `gbrain` on PATH for running a refusal's shell `fix.command` exactly as an agent would. */
export function shimPath(c: Case): string {
  const bin = join(c.fx.dir, 'shim-bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'gbrain'), `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${join(REPO, 'src', 'cli.ts')}" "$@"\n`);
  chmodSync(join(bin, 'gbrain'), 0o755);
  return `${bin}:${process.env.PATH}`;
}

/** Run a refusal's fix once: `fix.argv` through the CLI, or the shell `fix.command`. */
/** The first rendered fix (`next` run or tell_user_to_run) anywhere in an MCP reply, including JSON-encoded text content. */
export function findFix(value: unknown): Record<string, any> | null {
  if (typeof value === 'string') { try { return findFix(JSON.parse(value)); } catch { return null; } }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, any>;
  if ((record.next === 'run' || record.next === 'tell_user_to_run') && Array.isArray(record.argv)) return record;
  for (const child of Object.values(record)) { const found = findFix(child); if (found) return found; }
  return null;
}

export async function runFix(fix: Record<string, any>, home: string, c: Case): Promise<GbrainResult> {
  const env = { [TARGET_ENV]: c.target.url, PATH: shimPath(c) };
  // An agent fills `<name>` argv placeholders from fix.inputs (the user supplies the target URL).
  const filled = Array.isArray(fix.argv) ? (fix.argv as string[]).map(a => a === '<target_url>' ? c.target.url : a) : null;
  if (filled && filled[0] === 'gbrain') return gbrain(filled.slice(1), { home, env });
  expect(typeof fix.command).toBe('string');
  const child = Bun.spawn(['sh', '-c', fix.command], { env: { ...process.env, ...env, HOME: home, GBRAIN_HOME: home, DATABASE_URL: '', GBRAIN_DATABASE_URL: '' }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  return { code: child.exitCode ?? -1, signal: null, stdout, stderr, json: null, ms: 0 };
}
