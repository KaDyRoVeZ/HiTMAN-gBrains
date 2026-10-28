/**
 * content_drift_sweep doctor check (#7117): reports the content-drift
 * sweep's latest failure and each scope's last completed pass from the saved
 * sweep state, so a sweep that keeps failing is visible instead of silent.
 *
 * PGLite in-memory ($0).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { runContentDriftSweep } from '../src/core/content-drift-sweep.ts';
import { contentDriftSweepEntry } from '../src/commands/doctor/checks/content-drift-sweep.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { if (engine) await engine.disconnect(); }, 60_000);

async function check() {
  const checks = await contentDriftSweepEntry.run({ engine, args: [] } as unknown as DoctorContext);
  if (!Array.isArray(checks)) throw new Error('the entry stopped doctor');
  expect(checks.map(c => c.name)).toEqual(['content_drift_sweep']);
  return checks[0]!;
}

describe('content_drift_sweep doctor check', () => {
  test('ok before any sweep, warn while the latest batch failed, ok after a pass completes', async () => {
    expect(categorizeCheck('content_drift_sweep')).toBe('ops');
    const fresh = await check();
    expect(fresh.status).toBe('ok');
    expect(fresh.message).toContain('has not run yet');

    await engine.putPage('drift', { type: 'note', title: 'drift', compiled_truth: 'seeded' });
    await installFixtureChunks(engine, 'drift', [{ chunk_index: 0, chunk_text: 'old', chunk_source: 'compiled_truth', token_count: 1,
      embedding: new Float32Array(1536).fill(0.2) }]);
    await engine.executeRaw(`UPDATE content_chunks SET chunk_text = 'new' WHERE page_id = (SELECT id FROM pages WHERE slug = 'drift')`);
    await engine.executeRaw(`CREATE FUNCTION refuse_drift_write() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'drift writes refused for this test'; END $$`);
    await engine.executeRaw('CREATE TRIGGER refuse_drift_write BEFORE UPDATE ON content_chunks FOR EACH ROW EXECUTE FUNCTION refuse_drift_write()');
    try {
      expect((await runContentDriftSweep(engine)).state).toBe('failed');
    } finally {
      await engine.executeRaw('DROP TRIGGER refuse_drift_write ON content_chunks');
      await engine.executeRaw('DROP FUNCTION refuse_drift_write()');
    }
    const failing = await check();
    expect(failing.status).toBe('warn');
    expect(failing.message).toContain('drift writes refused for this test');
    expect(failing.fix?.argv).toEqual(['gbrain', 'embed', '--stale']);
    expect(failing.fix?.consent).toEqual(['paid']);

    expect((await runContentDriftSweep(engine)).state).toBe('complete');
    const healthy = await check();
    expect(healthy.status).toBe('ok');
    expect(healthy.message).toMatch(/last pass completed .* \(1 checked, 1 invalidated\)/);
  });
});
