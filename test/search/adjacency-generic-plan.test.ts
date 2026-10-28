/**
 * The search adjacency read stays on a per-call plan. Once a statement has run
 * five times Postgres may reuse a generic plan, and without planner statistics
 * (PGLite has no autovacuum) the generic plan of this read walked pages against
 * links: on a 2,000-page brain every MCP search after the fifth in a process
 * took about 7 s instead of about 45 ms.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
let ids: number[] = [];
const PAGES = 1500;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth)
    SELECT 'default', 'notes/adjacency-' || g, 'note', 'Adjacency ' || g, 'Body ' || g FROM generate_series(1, ${PAGES}) g`);
  await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
    SELECT a.id, b.id, 'mentions', 'markdown' FROM pages a JOIN pages b ON b.id IN (a.id + 1, a.id + 7, a.id + 31)
    ON CONFLICT DO NOTHING`);
  ids = (await engine.executeRaw<{ id: number }>('SELECT id FROM pages ORDER BY id LIMIT 40')).map(row => Number(row.id));
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

describe('search adjacency read', () => {
  test('the sixth and later calls in one process stay as fast as the first five', async () => {
    const scope = { sourceIds: ['default'] };
    const times: number[] = [];
    let result = new Map();
    for (let i = 0; i < 9; i++) {
      const started = performance.now();
      result = await engine.getAdjacencyBoosts(ids, scope);
      times.push(performance.now() - started);
    }
    expect(result.size).toBeGreaterThan(0);
    const early = Math.max(...times.slice(1, 5));
    const late = Math.max(...times.slice(5));
    expect({ times: times.map(Math.round), slow: late > Math.max(50, early * 10) }).toMatchObject({ slow: false });
  }, 120_000);
});
