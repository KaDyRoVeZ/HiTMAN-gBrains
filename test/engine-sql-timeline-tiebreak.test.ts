/**
 * #5883: `getTimeline` breaks same-date ties on the entry id.
 *
 * Protects: with a limit that cuts through a group of entries sharing one date,
 * the returned subset is the newest-inserted entries (id DESC), every time.
 * Fails when: the read orders by date alone, so the planner picks which
 * same-date entries survive the limit.
 * Seams: none; in-memory PGLite (the SQL is shared with Postgres).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({}); await engine.initSchema();
  await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme example', compiled_truth: 'Acme example.' });
  await engine.addTimelineEntry('companies/acme-example', { date: '2026-01-01', summary: 'Older event', source: 'notes' });
  for (const n of [1, 2, 3, 4, 5]) {
    await engine.addTimelineEntry('companies/acme-example', { date: '2026-03-01', summary: `Same-day event ${n}`, source: 'notes' });
  }
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

test('same-date entries cut by the limit come back newest id first', async () => {
  const all = await engine.getTimeline('companies/acme-example');
  expect(all.map(e => e.summary)).toEqual(['Same-day event 5', 'Same-day event 4', 'Same-day event 3', 'Same-day event 2', 'Same-day event 1', 'Older event']);
  const limited = await engine.getTimeline('companies/acme-example', { limit: 2 });
  expect(limited.map(e => e.summary)).toEqual(['Same-day event 5', 'Same-day event 4']);
});
