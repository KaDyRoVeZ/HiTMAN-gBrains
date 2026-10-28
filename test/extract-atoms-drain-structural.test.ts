/**
 * #5856: a drain the atom session preflight refuses structurally (no active
 * owner for a configured checkout, untrusted caller) dead-letters after ONE
 * attempt with `structural_refusal:` text and no model call, instead of
 * burning `max_attempts` retries.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { registerBuiltinHandlers } from '../src/commands/jobs.ts';
import { __setChatTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); resetGateway(); });

test('a structural refusal dead-letters after one attempt with structural_refusal text and no model call', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-drain-structural-'));
  const root = join(home, 'checkout');
  mkdirSync(root);
  let calls = 0;
  __setChatTransportForTests(async () => { calls++; throw new Error('the model must not be called'); });
  const worker = new MinionWorker(engine, { pollInterval: 30 });
  try {
    await withEnv({ GBRAIN_HOME: join(home, 'home'), ANTHROPIC_API_KEY: 'sk-test-structural' }, async () => {
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['git-unowned', root]);
      for (const n of [1, 2]) {
        await engine.putPage(`notes/unowned-${n}`, { type: 'note', title: `Unowned ${n}`,
          compiled_truth: `A durable decision ${n} recorded in prose. `.repeat(20) } as never, { sourceId: 'git-unowned' });
      }
      await engine.setConfig('sync.write_through', 'true');
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      const job = await new MinionQueue(engine).add('extract-atoms-drain', { sourceId: 'git-unowned', window: 60, repoPath: root },
        { queue: 'default', max_attempts: 3, backoff_delay: 10 }, { allowProtectedSubmit: true });
      await registerBuiltinHandlers(worker, engine, { quiet: true });
      const running = worker.start();
      let row: { status: string; attempts_started: number; error_text: string | null } | undefined;
      for (let i = 0; i < 300; i++) {
        [row] = await engine.executeRaw<NonNullable<typeof row>>('SELECT status,attempts_started,error_text FROM minion_jobs WHERE id=$1', [job.id]);
        if (row && ['dead', 'completed', 'failed'].includes(row.status) || (row?.attempts_started ?? 0) >= 2) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      worker.stop();
      await running;
      expect(row!.status).toBe('dead');
      expect(row!.attempts_started).toBe(1);
      expect(row!.error_text).toStartWith('structural_refusal: owner_unavailable: ');
      expect(calls).toBe(0);
    });
  } finally {
    worker.stop();
    __setChatTransportForTests(null);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(home, { recursive: true, force: true });
  }
}, 60_000);
