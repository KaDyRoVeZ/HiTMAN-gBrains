/**
 * #5875: a checkout-less autopilot cycle on a connector source extracts links
 * from the database instead of skipping `extract` with `no_brain_dir`.
 *
 * Authoring gate. (1) Protects link/timeline extraction for connector pages
 * (Gmail/Calendar renders), which have no on-disk checkout. (2) Fails when the
 * cycle skips the extract phase for `brainDir === null` (the phase reported
 * `skipped`/`no_brain_dir`, 0 links, 2 stale pages). (3) The existing
 * `autopilot-cycle-connector.serial.test.ts` mocks `runCycle`, so it cannot see
 * what the phase does; this runs the real handler and cycle, no mocks, in both
 * persistence modes and on every configured engine. (4) Serial: the fixture
 * toggles the brain-wide persistence switch and process env.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { makeAutopilotCycleHandler } from '../src/core/minions/handlers/autopilot-cycle.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../src/core/link-extraction.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, googleConfig } from './helpers/connector-fixture.ts';

const fixture = createConnectorFixture();
const { engines, env, source } = fixture;
beforeAll(fixture.setup, 120_000);
afterAll(fixture.teardown);

const person = '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n';
const email = '---\ntitle: Synthetic exchange\ntype: email\nthread_id: example\n---\nMet [[people/alice-example]] about the plan.\n';

async function seed(engine: BrainEngine, managed: boolean): Promise<string> {
  const f = await source(engine, googleConfig);
  if (managed) {
    const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: f.id, remote: false, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    for (const [slug, content] of [['people/alice-example', person], ['emails/example', email]]) {
      await submitPageMutation(ctx, { operation: 'put_page', params: { slug, content, request_id: randomUUID() } });
    }
    await disposePersistenceConsumer(engine);
  } else {
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.putPage('people/alice-example', { title: 'Alice Example', type: 'person', compiled_truth: '# Alice Example' }, { sourceId: f.id });
    await engine.putPage('emails/example', { title: 'Synthetic exchange', type: 'email', compiled_truth: 'Met [[people/alice-example]] about the plan.' }, { sourceId: f.id });
  }
  // What a connector publication leaves behind: pages with no derived links.
  await engine.executeRaw('DELETE FROM links WHERE from_page_id IN (SELECT id FROM pages WHERE source_id=$1)', [f.id]);
  await engine.executeRaw('UPDATE pages SET links_extracted_at=NULL WHERE source_id=$1', [f.id]);
  return f.id;
}

async function linkCount(engine: BrainEngine, sourceId: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM links l JOIN pages p ON p.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
      WHERE p.source_id=$1 AND p.slug='emails/example' AND t.slug='people/alice-example'`, [sourceId]);
  return rows[0].n;
}

describe('#5875 checkout-less connector cycle extract', () => {
  for (const managed of [true, false]) {
    test(`${managed ? 'managed' : 'unmanaged'}: extract drains stale connector pages from the database`, async () => withEnv(env, async () => {
      for (const engine of engines) {
        const sourceId = await seed(engine, managed);
        expect(await engine.countStalePagesForExtraction({ sourceId, versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(2);
        const out = await makeAutopilotCycleHandler(engine)({ id: 1, data: { source_id: sourceId } } as never) as {
          report: { brain_dir: string | null; phases: Array<{ phase: string; status: string; details: Record<string, unknown> }> };
        };
        expect(out.report.brain_dir).toBeNull();
        const extract = out.report.phases.find(p => p.phase === 'extract');
        expect(extract?.status).toBe('ok');
        expect(extract?.details).toMatchObject({ database_only: true, stale_pages_drained: 2, staleRemaining: 0 });
        expect(await linkCount(engine, sourceId)).toBe(1);
        expect(await engine.countStalePagesForExtraction({ sourceId, versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(0);
        await disposePersistenceConsumer(engine);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      }
    }), 180_000);
  }

  test('a dry run reports extract skipped and drains nothing', async () => withEnv(env, async () => {
    const { runCycle } = await import('../src/core/cycle.ts');
    for (const engine of engines) {
      const sourceId = await seed(engine, false);
      const report = await runCycle(engine, { brainDir: null, sourceId, phases: ['extract'], dryRun: true } as never);
      const extract = report.phases.find(p => p.phase === 'extract');
      expect(extract).toMatchObject({ status: 'skipped', details: { reason: 'no_dry_run_support', database_only: true } });
      expect(await linkCount(engine, sourceId)).toBe(0);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  }), 120_000);

  test('a per-source cycle drains only its own source', async () => withEnv(env, async () => {
    for (const engine of engines) {
      const other = await seed(engine, false);
      const target = await seed(engine, false);
      await makeAutopilotCycleHandler(engine)({ id: 1, data: { source_id: target } } as never);
      expect(await linkCount(engine, target)).toBe(1);
      expect(await linkCount(engine, other)).toBe(0);
      expect(await engine.countStalePagesForExtraction({ sourceId: other, versionTs: LINK_EXTRACTOR_VERSION_TS })).toBe(2);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    }
  }), 180_000);
});
