/**
 * #5854: a drain attempt shares one maintenance publish wait across its
 * batches. When the canonical writer is busy, the first pending atom publish
 * costs one wait; every later publish in the attempt (the rest of the batch,
 * and the next batch resuming it) is deferred without waiting, and the
 * accepted batch commits once the writer frees up.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { runExtractAtomsDrainForSource } from '../src/core/cycle/extract-atoms-drain.ts';
import { MaintenanceWriteWait, __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import { acquireWorktree, claimWorktree } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); resetGateway(); });

test('a busy writer during a two-batch drain costs one wait; the deferred batch commits after it frees up', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-drain-wait-'));
  const root = join(home, 'repo');
  const sourceId = 'atoms-wait';
  const waits: number[] = [];
  const ms = MaintenanceWriteWait.prototype.ms;
  const spy = spyOn(MaintenanceWriteWait.prototype, 'ms').mockImplementation(function (this: MaintenanceWriteWait) {
    const value = ms.call(this);
    waits.push(value);
    return value;
  });
  __setMaintenanceWriteWaitForTests(400);
  try {
    await withEnv({ GBRAIN_HOME: join(home, 'home'), ANTHROPIC_API_KEY: 'sk-test-drain-wait' }, async () => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      mkdirSync(join(root, 'notes'), { recursive: true });
      for (const n of [1, 2]) {
        await engine.putPage(`notes/wait-${n}`, { type: 'note', title: `Wait ${n}`,
          compiled_truth: `Decision ${n}: a durable choice recorded in prose. `.repeat(20) } as never, { sourceId });
        writeFileSync(join(root, `notes/wait-${n}.md`), serializePageToMarkdown((await engine.getPage(`notes/wait-${n}`, { sourceId }))!, []));
      }
      await engine.setConfig('cycle.extract_atoms.page_discovery_budget', '1');
      await engine.setConfig('sync.write_through', 'true');
      await registerLocalWriter(engine, 'cli');
      const binding = await claimWorktree(engine, sourceId, root);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      let lock: Awaited<ReturnType<typeof acquireWorktree>> = null;
      let calls = 0;
      __setChatTransportForTests(async (opts) => {
        calls++;
        lock = await acquireWorktree(binding, 1000);
        const text = JSON.stringify([{ title: `Exit criteria ${calls}`, atom_type: 'insight', body: `Measure progress against clear exit criteria ${calls}.` }]);
        return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
          usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: opts.model!, providerId: 'anthropic' };
      });
      const started = performance.now();
      const result = await runExtractAtomsDrainForSource(engine, { sourceId, windowSeconds: 120, maxBatches: 2,
        onBatch: () => { void lock?.release(); lock = null; } });
      const elapsed = performance.now() - started;
      await (lock as Awaited<ReturnType<typeof acquireWorktree>>)?.release();
      expect(calls).toBe(1);
      expect(result.batches).toBe(2);
      expect(result.extracted).toBe(1);
      expect(waits.filter(w => w > 0)).toEqual([400]);
      expect(waits.length).toBeGreaterThanOrEqual(3);
      expect(elapsed).toBeLessThan(5_000);
      await disposePersistenceConsumer(engine);
      for (let i = 0; i < 100; i++) {
        const open = await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND state<>'committed'", [sourceId]);
        if (!open.length) break;
        await waitForCommit();
      }
      expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND state<>'committed'", [sourceId])).toEqual([]);
      expect(await engine.executeRaw("SELECT slug FROM pages WHERE source_id=$1 AND type='atom' AND deleted_at IS NULL", [sourceId])).toHaveLength(1);
    });
  } finally {
    spy.mockRestore();
    __setMaintenanceWriteWaitForTests(null);
    __setChatTransportForTests(null);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);

async function waitForCommit(): Promise<void> {
  const { startPersistenceConsumer } = await import('../src/core/persistence/service.ts');
  startPersistenceConsumer(engine, { engine: engine.kind } as never).wake();
  await new Promise(resolve => setTimeout(resolve, 100));
}
