/**
 * #5828 — the brain_score timeline component grades only pages whose
 * active-pack primitive is `entity` or `temporal`. Pre-fix its denominator
 * was every linkable page, so a brain whose events all had timeline rows
 * still read 2/15 when it also held reference notes, and the only way to
 * 15/15 was stamping non-event rows onto every document.
 *
 * Repro shape from the issue: 10 meetings (temporal, one timeline row each)
 * + 90 undated reference notes (concept), all linked.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { _resetPackCacheForTests } from '../src/core/schema-pack/registry.ts';
import { withEnv } from './helpers/with-env.ts';
import { loadTimelineGradedPredicate } from '../src/core/timeline-grading.ts';

let engine: PGLiteEngine;
const home = mkdtempSync(join(tmpdir(), 'gbrain-5828-'));
const env = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, GBRAIN_SCHEMA_PACK: undefined }, fn);

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  _resetPackCacheForTests();
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
});

async function seed(meetings: number, notes: number, extraType?: string): Promise<void> {
  const slugs: string[] = [];
  for (let i = 0; i < meetings; i++) {
    const slug = `meetings/2026-01-${String(i + 1).padStart(2, '0')}-example-sync`;
    await engine.putPage(slug, { type: 'meeting', title: `Example sync ${i}`, compiled_truth: `Notes from example sync ${i}.`, frontmatter: {} });
    await engine.addTimelineEntry(slug, { date: `2026-01-${String(i + 1).padStart(2, '0')}`, source: 'meeting', summary: 'Sync held' });
    slugs.push(slug);
  }
  for (let i = 0; i < notes; i++) {
    const slug = `notes/reference-${i}`;
    await engine.putPage(slug, { type: extraType ?? 'note', title: `Reference ${i}`, compiled_truth: `Reference text ${i}.`, frontmatter: {} });
    slugs.push(slug);
  }
  for (let i = 1; i < slugs.length; i++) {
    await engine.addLink(slugs[i - 1], slugs[i], '', 'related');
    await engine.addLink(slugs[i], slugs[i - 1], '', 'related');
  }
}

describe('#5828 timeline component grades entity/temporal pages only', () => {
  test('events all on the timeline + undated reference notes -> full timeline points', async () => {
    await seed(10, 90);
    const h = await env(() => engine.getHealth());
    expect(h.linkable_page_count).toBe(100);
    expect(h.timeline_coverage_score).toBe(15);
  });

  test('an event missing its row still costs points', async () => {
    await seed(10, 90);
    await engine.executeRaw(`DELETE FROM timeline_entries WHERE page_id IN (SELECT id FROM pages WHERE slug LIKE 'meetings/2026-01-0%')`);
    const h = await env(() => engine.getHealth());
    // 1 of 10 meetings keeps its row (2026-01-10).
    expect(h.timeline_coverage_score).toBe(Math.round((1 / 10) * 15));
  });

  test('types the pack does not declare stay graded', async () => {
    await seed(10, 10, 'research-memo-example');
    const h = await env(() => engine.getHealth());
    expect(h.timeline_coverage_score).toBe(Math.round((10 / 20) * 15));
  });

  test('predicate: aliases resolve to their canonical primitive; no pack grades everything', async () => {
    const graded = await env(() => loadTimelineGradedPredicate(engine));
    expect(graded('person')).toBe(true);
    expect(graded('meeting')).toBe(true);
    expect(graded('email-thread')).toBe(true); // alias of email (temporal)
    expect(graded('note')).toBe(false);
    expect(graded('memo')).toBe(false); // alias of note (concept)
    expect(graded('writing')).toBe(false);
    expect(graded('undeclared-example')).toBe(true);
    expect(graded('')).toBe(true);
    await engine.setConfig('schema_pack', 'no-such-pack-example');
    _resetPackCacheForTests();
    const fallback = await env(() => loadTimelineGradedPredicate(engine));
    expect(fallback('note')).toBe(true);
  });
});
