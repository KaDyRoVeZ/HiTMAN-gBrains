/**
 * GBRA-150 doctor `sync_landing_gaps`: warns per source for pages a managed sync committed past the freshness target
 * that search cannot fully see, with the first page's fix; ok when there are none; not applicable when managed
 * persistence is off. It is a cheap incident check (runs before the full scans). Red on master: the check does not exist.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Check } from '../src/commands/doctor.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { syncLandingGapsEntry } from '../src/commands/doctor/checks/landing-gaps.ts';
import { CHEAP_INCIDENT_CHECKS } from '../src/commands/doctor/registry.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-doctor-landing-'));
let engine: PGLiteEngine;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const note = (title: string) => `---\ntitle: ${title}\n---\nA synthetic observation about ${title}.\n`;

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

const run = async (sourceIds: string[]) => (await syncLandingGapsEntry.run({ engine, sourceIds } as unknown as DoctorContext) as Check[])[0]!;

test('warns with the per-page reason and fix once a synced page outlives the target unembedded; ok under the target; a cheap incident check', () => withEnv({ GBRAIN_HOME: home }, async () => {
  expect(CHEAP_INCIDENT_CHECKS.has('sync_landing_gaps')).toBe(true);
  await engine.setConfig('embedding_disabled', 'false');
  const id = `dlg-${randomUUID().replace(/-/g, '').slice(0, 20)}`, repo = join(home, id);
  mkdirSync(join(repo, 'notes'), { recursive: true }); git(repo, 'init', '-q');
  writeFileSync(join(repo, 'notes/a.md'), note('A'));
  git(repo, 'add', '-A'); git(repo, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'a');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, repo]);
  await claimWorktree(engine, id, repo);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });
  writeFileSync(join(repo, 'notes/b.md'), note('B'));
  git(repo, 'add', '-A'); git(repo, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'b');
  await performManagedSync(engine, { sourceId: id, noPull: true, noEmbed: true, noExtract: true });

  await engine.setConfig('sync.freshness_target_seconds', '3600');
  expect(await run([id])).toMatchObject({ name: 'sync_landing_gaps', status: 'ok' });
  await engine.setConfig('sync.freshness_target_seconds', '0.001');
  const warn = await run([id]);
  expect(warn).toMatchObject({ name: 'sync_landing_gaps', status: 'warn', fix: { argv: ['gbrain', 'embed', '--stale', '--catch-up', '--source', id, '--yes'], consent: ['paid'] } });
  expect(warn.message).toContain(`${id}: `);
  expect(warn.message).toContain('notes/b [pending_embedding]');
  await engine.setConfig('sync.freshness_target_seconds', '');
}), 120_000);

test('not applicable when managed persistence is off', () => withEnv({ GBRAIN_HOME: home }, async () => {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try { expect(await run([])).toMatchObject({ name: 'sync_landing_gaps', status: 'ok', severity: 'info', readiness_state: 'not_applicable' }); }
  finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}), 60_000);
