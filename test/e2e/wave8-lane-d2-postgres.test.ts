/**
 * Fix wave 8 lane D2 on Postgres: the SQL the lane added runs on postgres.js
 * exactly as on PGLite (JSONB frontmatter read back as an object, text[]
 * binds, integer length bound, per-type getHealth rows).
 *
 *   #5828  getHealth timeline component grades only entity/temporal types
 *   #5879  findTypeOrphans + doctor schema_pack_consistency count undeclared types
 *   #4419  discoverConversationPages reads conversation pages + frontmatter dates
 *
 * DATABASE_URL gated — skips when not set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { findTypeOrphans } from '../../src/core/schema-pack/review.ts';
import { loadResolvedPackByName } from '../../src/core/schema-pack/load-active.ts';
import { _resetPackCacheForTests } from '../../src/core/schema-pack/registry.ts';
import { checkSchemaPackConsistency } from '../../src/commands/doctor/schema-pack-checks.ts';
import { discoverConversationPages } from '../../src/core/cycle/transcript-discovery.ts';

const describePg = hasDatabase() ? describe : describe.skip;

async function seed(engine: BrainEngine): Promise<void> {
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
  const slugs: string[] = [];
  for (let i = 0; i < 4; i++) {
    const slug = `meetings/2026-02-0${i + 1}-example-sync`;
    await engine.putPage(slug, { type: 'meeting', title: `Sync ${i}`, compiled_truth: `Sync ${i}.`, frontmatter: {} });
    await engine.addTimelineEntry(slug, { date: `2026-02-0${i + 1}`, source: 'meeting', summary: 'Sync held' });
    slugs.push(slug);
  }
  for (let i = 0; i < 12; i++) {
    const slug = `notes/reference-${i}`;
    await engine.putPage(slug, { type: 'note', title: `Ref ${i}`, compiled_truth: `Ref ${i}.`, frontmatter: {} });
    slugs.push(slug);
  }
  for (let i = 0; i < 3; i++) {
    await engine.putPage(`meetings/2026-02-1${i}-sync-transcript`, { type: 'meeting-transcript', title: `T ${i}`, compiled_truth: 'transcript', frontmatter: {} });
  }
  await engine.putPage('conversations/2026-02-20-session', {
    type: 'conversation', title: 'Session', compiled_truth: 'alice-example: hello\n\nassistant: hi there',
    frontmatter: { date: '2026-02-20', transcript_import: { harness: 'hermes', session_id: 'example-1', part: 1, of: 1 } },
  });
  for (let i = 1; i < slugs.length; i++) {
    await engine.addLink(slugs[i - 1], slugs[i], '', 'related');
    await engine.addLink(slugs[i], slugs[i - 1], '', 'related');
  }
}

describePg('wave 8 lane D2 — Postgres parity', () => {
  let pglite: PGLiteEngine;
  let postgres: BrainEngine;

  beforeAll(async () => {
    _resetPackCacheForTests();
    pglite = new PGLiteEngine();
    await pglite.connect({ engine: 'pglite' } as never);
    await pglite.initSchema();
    await seed(pglite);
    postgres = await setupDB();
    await seed(postgres);
  }, 120_000);

  afterAll(async () => {
    if (pglite) await pglite.disconnect();
    await teardownDB();
  });

  test('#5828 timeline component: same graded score on both engines, notes not graded', async () => {
    const [a, b] = [await pglite.getHealth(), await postgres.getHealth()];
    expect(b.timeline_coverage_score).toBe(a.timeline_coverage_score);
    // 4 meetings with rows + 3 undeclared-type pages without -> round(4/7*15) = 9; notes excluded.
    expect(b.timeline_coverage_score).toBe(Math.round((4 / 7) * 15));
  });

  test('#5879 orphan review and doctor consistency count undeclared types', async () => {
    const pack = (await loadResolvedPackByName('gbrain-base-v2')).manifest;
    for (const engine of [pglite, postgres]) {
      const r = await findTypeOrphans(engine, pack, { sourceIds: ['default'] }, 2);
      expect(r.orphan_count).toBe(3);
      expect(r.orphans).toHaveLength(2);
      expect(r.undeclared_types).toEqual([{ type: 'meeting-transcript', count: 3 }]);
      const check = await checkSchemaPackConsistency(engine, { sourceIds: ['default'] });
      expect(check.status).toBe('warn');
      expect(check.details?.code).toBe('page_type_undeclared');
    }
  });

  test('#4419 conversation pages discovered with their frontmatter date', async () => {
    for (const engine of [pglite, postgres]) {
      const found = await discoverConversationPages(engine, { sourceId: 'default', minChars: 10, date: '2026-02-20' });
      expect(found.map((t) => t.filePath)).toEqual(['gbrain-page://default/conversations/2026-02-20-session']);
      expect(found[0].inferredDate).toBe('2026-02-20');
    }
  });
});
