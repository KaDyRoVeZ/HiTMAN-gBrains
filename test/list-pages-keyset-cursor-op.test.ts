/**
 * list_pages keyset cursor (updated_after + updated_after_slug).
 *
 * The engine has carried PageFilters.updatedAfterKeyset since v0.45.7, but
 * the op never exposed it, and the documented pagination recipe
 * (sort=updated_asc + updated_after=<last row's updated_at>) is lossy: the
 * strict `updated_at > value` predicate skips every row SHARING the cursor
 * timestamp — and a bulk sync stamps one now() across a transaction, so a
 * >limit same-timestamp cluster is exactly the shape real brains produce.
 * With such a cluster the bare cursor cannot make progress at all.
 *
 * Pins, at the op-handler layer (engine listPages surface unchanged):
 *   - a >limit same-timestamp cluster pages to completion via the keyset
 *     (fails pre-fix: the bare recipe returns 0 rows after page one)
 *   - the cursor resumes STRICTLY after (updated_at, slug): same-ts rows
 *     with a greater slug are returned, the cursor row itself is not
 *   - the keyset supersedes the bare updated_after filter semantics
 *   - the keyset forces sort=updated_asc (a caller-passed sort is ignored —
 *     the cursor is only coherent under that total order)
 *   - composes with the type filter across rows with DIFFERING types
 *   - updated_after_slug without updated_after fails loudly
 *   - output rows carry updated_at_iso (column precision), the value the
 *     next page's updated_after must be built from — a JS Date is
 *     millisecond-truncated and re-selects same-millisecond rows
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';

const list_pages = operations.find(o => o.name === 'list_pages')!;

let engine: PGLiteEngine;

const TS = '2026-08-10T12:00:00.000123Z';
const CLUSTER = 7; // > limit 3 used below: unpageable with a bare cursor

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (let i = 1; i <= CLUSTER; i++) {
    await engine.putPage(`notes/sync-${i}`, {
      type: i % 2 === 0 ? 'note' : 'reference',
      title: `Synced ${i}`,
      compiled_truth: `Body ${i}.`,
      timeline: '',
    });
  }
  // One identical timestamp across the whole cluster — the bulk-sync shape.
  await engine.executeRaw(
    `UPDATE pages SET updated_at = '${TS}'::timestamptz WHERE slug LIKE 'notes/sync-%'`,
  );
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

function ctxOf(): OperationContext {
  return {
    engine: engine as any,
    config: {} as any,
    logger: console as any,
    dryRun: false,
    remote: false,
    sourceId: 'default',
  };
}

type Row = { slug: string; updated_at_iso: string; type: string };
const run = (params: Record<string, unknown>) =>
  list_pages.handler(ctxOf(), params) as Promise<Row[]>;

describe('list_pages keyset cursor', () => {
  test('a >limit same-timestamp cluster pages to completion', async () => {
    const seen: string[] = [];
    let cursor: { updated_after?: string; updated_after_slug?: string } = {};
    for (let guard = 0; guard < 10; guard++) {
      const rows = await run({ limit: 3, sort: 'updated_asc', ...cursor });
      seen.push(...rows.map(r => r.slug));
      if (rows.length < 3) break;
      const last = rows[rows.length - 1];
      cursor = { updated_after: last.updated_at_iso, updated_after_slug: last.slug };
    }
    expect(seen.sort()).toEqual(
      Array.from({ length: CLUSTER }, (_, i) => `notes/sync-${i + 1}`).sort(),
    );
    expect(new Set(seen).size).toBe(CLUSTER); // no row twice
  });

  test('resumes strictly after (updated_at, slug): greater-slug rows in, cursor row out', async () => {
    const rows = await run({
      updated_after: TS, updated_after_slug: 'notes/sync-3', limit: 100,
    });
    const slugs = rows.map(r => r.slug);
    expect(slugs).not.toContain('notes/sync-3');
    expect(slugs).toContain('notes/sync-4'); // same ts, greater slug — bare updated_after drops it
    expect(slugs).toContain('notes/sync-7');
  });

  test('bare updated_after stays the (documented-lossy) strict filter', async () => {
    const rows = await run({ updated_after: TS, sort: 'updated_asc', limit: 100 });
    expect(rows.map(r => r.slug).filter(s => s.startsWith('notes/sync-'))).toEqual([]);
  });

  test('keyset forces sort=updated_asc over a caller-passed sort', async () => {
    const rows = await run({
      updated_after: TS, updated_after_slug: 'notes/sync-1', sort: 'updated_desc', limit: 2,
    });
    // Under the forced total order the next rows after sync-1 are sync-2, sync-3.
    expect(rows.map(r => r.slug)).toEqual(['notes/sync-2', 'notes/sync-3']);
  });

  test('composes with the type filter across rows with differing types', async () => {
    const rows = await run({
      updated_after: TS, updated_after_slug: 'notes/sync-2', type: 'note', limit: 100,
    });
    // Cursor sits on sync-2 (a 'note'); remaining notes are the even slugs after it.
    expect(rows.map(r => r.slug)).toEqual(['notes/sync-4', 'notes/sync-6']);
  });

  test('updated_after_slug without updated_after fails loudly', async () => {
    await expect(run({ updated_after_slug: 'notes/sync-1' })).rejects.toThrow(/requires updated_after/);
  });

  test('output rows carry updated_at_iso at column precision', async () => {
    const rows = await run({ sort: 'updated_asc', limit: 1 });
    expect(rows[0].updated_at_iso).toBe(TS); // microseconds survive (.000123Z)
  });
});
