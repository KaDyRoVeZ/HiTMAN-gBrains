/**
 * #5891: find_orphans returned every orphan in one response (2.3 MB on a
 * 23k-page multi-source brain) with no way to page, filter by source, or tell
 * which source a row came from. The op now pages (limit/offset, next_offset),
 * has count_only, filters by a source inside the caller's grant, and each row
 * carries source_id and type.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';

let engine: PGLiteEngine;
const op = operations.find(o => o.name === 'find_orphans')!;
const ctx = (over: Record<string, unknown> = {}) => ({
  engine, config: { engine: 'pglite' as const }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, ...over,
}) as never;
type Result = { orphans: Array<{ slug: string; source_id?: string; type?: string | null }>; total_orphans: number; limit: number; offset: number; next_offset: number | null };
const call = async (c: never, p: Record<string, unknown>) => op.handler(c, p) as Promise<Result>;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('src-b', 'src-b') ON CONFLICT DO NOTHING");
  for (let i = 0; i < 5; i++) {
    await engine.putPage(`people/a-${i}`, { type: 'person', title: `A ${i}`, compiled_truth: 'Body.' }, { sourceId: 'default' });
  }
  for (let i = 0; i < 3; i++) {
    await engine.putPage(`companies/b-${i}`, { type: 'company', title: `B ${i}`, compiled_truth: 'Body.' }, { sourceId: 'src-b' });
  }
}, 60_000);
afterAll(async () => { await engine.disconnect(); });

describe('find_orphans paging and source filter (#5891)', () => {
  test('pages through every orphan in a stable order with next_offset; rows carry source_id and type', async () => {
    const local = ctx({ remote: false });
    const first = await call(local, { limit: 3 });
    expect(first.total_orphans).toBe(8);
    expect(first.orphans).toHaveLength(3);
    expect(first.next_offset).toBe(3);
    expect(first.orphans[0]).toMatchObject({ slug: 'people/a-0', source_id: 'default', type: 'person' });
    const rest = await call(local, { limit: 3, offset: 3 });
    const last = await call(local, { limit: 3, offset: 6 });
    expect(last.next_offset).toBeNull();
    const all = [...first.orphans, ...rest.orphans, ...last.orphans].map(r => `${r.source_id}:${r.slug}`);
    expect(new Set(all).size).toBe(8);
    expect(all.slice(-3)).toEqual(['src-b:companies/b-0', 'src-b:companies/b-1', 'src-b:companies/b-2']);
  });

  test('the default page is bounded and count_only returns totals with no rows', async () => {
    const result = await call(ctx({ remote: false }), {});
    expect(result.limit).toBe(100);
    const counted = await call(ctx({ remote: false }), { count_only: true });
    expect(counted.orphans).toEqual([]);
    expect(counted.total_orphans).toBe(8);
    await expect(call(ctx({ remote: false }), { limit: 0 })).rejects.toThrow('limit must be');
  });

  test('source_id narrows inside the grant and never widens it', async () => {
    const federated = ctx({ remote: true, sourceId: 'default', auth: { token: 't', clientId: 'c', scopes: ['read'], sourceId: 'default', allowedSources: ['default', 'src-b'] } });
    const onlyB = await call(federated, { source_id: 'src-b' });
    expect(onlyB.orphans.map(r => r.source_id)).toEqual(['src-b', 'src-b', 'src-b']);
    const bound = ctx({ remote: true, sourceId: 'default', auth: { token: 't', clientId: 'c', scopes: ['read'], sourceId: 'default' } });
    await expect(call(bound, { source_id: 'src-b' })).rejects.toThrow('Unknown source: src-b');
    expect((await call(bound, {})).orphans.every(r => r.source_id === 'default')).toBe(true);
  });
});
