/**
 * Alias resolution drives from the matching alias rows. Without planner
 * statistics (PGLite has no autovacuum), the page_aliases -> sources foreign key
 * (#5094) flipped the plan so every alias lookup walked all readable pages; at
 * 10k pages that added about 20 ms to every MCP search.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

let engine: PGLiteEngine;
let captured: { sql: string; params: unknown[] } | null = null;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('second-example', 'second-example') ON CONFLICT DO NOTHING");
  for (let i = 0; i < 300; i++) {
    await engine.putPage(`notes/page-${i}`, { type: 'note', title: `Page ${i}`, compiled_truth: `Body ${i}.` }, { sourceId: i % 2 ? 'default' : 'second-example' });
  }
}, 120_000);
afterAll(async () => { await engine.disconnect(); });

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'Actual Loops'?: number; Plans?: PlanNode[] };
const nodes = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(nodes)];

describe('alias reads look aliases up first', () => {
  test('a lookup whose alias matches nothing reads no page rows', async () => {
    const original = engine.executeRaw.bind(engine);
    (engine as unknown as { executeRaw: typeof original }).executeRaw = (async (sql: string, params?: unknown[]) => {
      if (/FROM page_aliases/.test(sql)) captured = { sql, params: params ?? [] };
      return original(sql, params);
    }) as typeof original;
    try {
      await engine.resolveAliases(['missing-alias-example'], { sourceIds: ['default', 'second-example'] });
    } finally {
      (engine as unknown as { executeRaw: typeof original }).executeRaw = original;
    }
    expect(captured).not.toBeNull();
    const [row] = await engine.executeRaw<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${captured!.sql}`, captured!.params);
    const all = nodes(row!['QUERY PLAN'][0]!.Plan);
    const pageScans = all.filter(n => n['Relation Name'] === 'pages' && /Scan/.test(n['Node Type']) && (n['Actual Loops'] ?? 0) > 0);
    expect(pageScans).toEqual([]);
  });
});
