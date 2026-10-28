/**
 * #5595 item 1: restoring a canonical page during publication recovery
 * reapplied the recorded mode with a path chmod and then fsynced the staged
 * file through a read-only handle. Windows refuses that flush (EPERM), so the
 * recovery failed on every retry and the serial worktree queue wedged behind
 * it. The staged file now gets its mode with fchmod and its flush on the
 * descriptor it was written through.
 *
 * The simulated cases make an `'r'`-handle file flush fail with EPERM on
 * every OS; the native cases run unmodified on the windows-latest
 * security-regressions row. The 0444 case pins that a preserved read-only
 * mode survives publication and recovery exactly (O-ENG-2).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { claimWorktree, type WorktreeBinding } from '../src/core/persistence/ownership.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite, completeWrite, prepareRecovery } from '../src/core/persistence/journal.ts';
import { publishMutation, recoverPublication } from '../src/core/persistence/coordinator.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { sameFileMode } from '../src/core/fs-durable.ts';
import { withEnv } from './helpers/with-env.ts';
import { simulateReadOnlyFsyncEperm } from './helpers/win32-flush-semantics.ts';

interface Fixture { sourceId: string; root: string; path: string; binding: WorktreeBinding }
let engine: BrainEngine;
let hostId: string;
let home: string;
const fixtures: Fixture[] = [];
const posixNonRoot = process.platform !== 'win32' && process.getuid?.() !== 0;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-5595-'));
  await withEnv({ GBRAIN_HOME: home }, async () => {
    hostId = localHostId();
    engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
    for (let i = 0; i < 4; i++) {
      const sourceId = `windows-flush-${i}`;
      const root = join(home, `root-${i}`); mkdirSync(root);
      const path = join(root, 'page.md'); writeFileSync(path, 'original');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      fixtures.push({ sourceId, root, path, binding: await claimWorktree(engine, sourceId, root, hostId) });
    }
    await registerLocalWriter(engine, 'cli');
    await activatePersistence(engine, { confirmQuiesced: true });
  });
}, 120_000);
afterAll(async () => {
  await engine?.disconnect();
  for (const f of fixtures) try { chmodSync(f.path, 0o644); } catch { /* removed below */ }
  if (home) rmSync(home, { recursive: true, force: true });
});

async function accepted(f: Fixture) {
  const authority = await submissionAuthority({ engine, remote: false, sourceId: f.sourceId } as OperationContext,
    'put_page', f.sourceId, f.binding.source_incarnation, 'page');
  const current = await engine.readPageSnapshot('page', { sourceId: f.sourceId });
  const row = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: f.sourceId,
    sourceIncarnation: f.binding.source_incarnation, slug: 'page', worktreeId: f.binding.worktree_id,
    topologyGeneration: f.binding.topology_generation, pageId: current?.page.id ?? null,
    callerIntent: { content: 'replacement' }, intent: { content: 'replacement' } });
  const claimed = (await claimNextWrite(engine, hostId))!;
  expect(claimed.id).toBe(row.id);
  return { row: claimed, observedRevision: current?.revision ?? null };
}

/** A publication that renamed `replacement` over the file and then crashed: recovery must restore `original`. */
async function interruptedPublication(f: Fixture, mode: number) {
  const { row } = await accepted(f);
  await prepareRecovery(engine, row, { version: 1, path: f.path, root: f.root, before: Buffer.from('original').toString('base64'),
    beforeHash: sha256('original'), afterHash: sha256('replacement'), mode, ownerEpoch: String(f.binding.owner_epoch), attempt: row.execution_token! }, 4096);
  writeFileSync(f.path, 'replacement');
  return row;
}
const stages = (f: Fixture) => readdirSync(f.root).filter(name => name.includes('.tmp.'));

test('#5595: recovery restores a moded page when read-only-handle file flushes fail (Windows semantics)', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const f = fixtures[0];
  const row = await interruptedPublication(f, 0o600);
  const simulation = simulateReadOnlyFsyncEperm();
  let recovered;
  try { recovered = await recoverPublication(engine, row.id, hostId); } finally { simulation.restore(); }
  expect(simulation.readOnlyFsyncs).toBe(0);
  expect(recovered.state).toBe('queued');
  expect(recovered.recovery).toBeNull();
  expect(readFileSync(f.path, 'utf8')).toBe('original');
  expect(sameFileMode(statSync(f.path).mode, 0o600)).toBe(true);
  expect(stages(f)).toEqual([]);
  await engine.transaction(tx => completeWrite(tx, recovered, 'cancelled', {}));
}));

test('#5595: recovery restores a moded page natively on this platform', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const f = fixtures[1];
  const row = await interruptedPublication(f, 0o644);
  const recovered = await recoverPublication(engine, row.id, hostId);
  expect(recovered.state).toBe('queued');
  expect(recovered.recovery).toBeNull();
  expect(readFileSync(f.path, 'utf8')).toBe('original');
  expect(sameFileMode(statSync(f.path).mode, 0o644)).toBe(true);
  expect(stages(f)).toEqual([]);
  await engine.transaction(tx => completeWrite(tx, recovered, 'cancelled', {}));
}));

test.skipIf(!posixNonRoot)('a preserved 0444 page publishes and recovers with exact bytes and mode', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  const f = fixtures[2];
  chmodSync(f.path, 0o444);
  const { row, observedRevision } = await accepted(f);
  const done = await publishMutation(engine, row, { observedRevision, file: { path: f.path, root: f.root, content: 'replacement' },
    apply: async (tx: BrainEngine) => {
      await tx.putPage('page', { type: 'note', title: 'Frozen example', compiled_truth: 'replacement', frontmatter: {} }, { sourceId: f.sourceId });
      return { slug: 'page' };
    } }, hostId);
  expect(done.state).toBe('committed');
  expect(readFileSync(f.path, 'utf8')).toBe('replacement');
  expect(statSync(f.path).mode & 0o7777).toBe(0o444);

  const g = fixtures[3];
  const interrupted = await interruptedPublication(g, 0o444);
  const recovered = await recoverPublication(engine, interrupted.id, hostId);
  expect(recovered.state).toBe('queued');
  expect(readFileSync(g.path, 'utf8')).toBe('original');
  expect(statSync(g.path).mode & 0o7777).toBe(0o444);
  expect(stages(g)).toEqual([]);
  await engine.transaction(tx => completeWrite(tx, recovered, 'cancelled', {}));
}));
