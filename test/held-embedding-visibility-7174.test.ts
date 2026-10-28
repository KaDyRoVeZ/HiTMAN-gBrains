/**
 * #7174: pages held from embedding stay findable and visible.
 *
 * - Doctor `partial_embedding` says how many held or capped pages have waited more than a day
 *   (their budget row unchanged) and since when, so a hold nobody decided on is not silent.
 *
 * Hermetic PGLite through the same seed the held-embedding CLI tests use.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { seedHeldPage } from './helpers/held-embedding-fixture.ts';
import { budgetLimitedFinding } from '../src/core/held-embedding.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

describe('doctor partial_embedding names holds nobody decided on', () => {
  test('a hold unchanged for two days is counted with its date; a fresh one is not', async () => {
    await seedHeldPage(engine, 'archive/old-example', 'default', 2);
    await seedHeldPage(engine, 'archive/new-example', 'default', 2);
    await engine.executeRaw("UPDATE page_embedding_budget SET updated_at = now() - interval '2 days' WHERE page_id = (SELECT id FROM pages WHERE slug = 'archive/old-example')");
    const [row] = await engine.executeRaw<{ at: Date }>("SELECT b.updated_at AS at FROM page_embedding_budget b JOIN pages p ON p.id = b.page_id WHERE p.slug = 'archive/old-example'");
    const at = new Date(row!.at).toISOString();
    const found = await budgetLimitedFinding(engine, null);
    expect(found?.details).toMatchObject({ held: 2, waiting_over_day: 1, oldest_updated_at: at });
    expect(found?.message).toContain(` 1 of them have waited more than a day (oldest unchanged since ${at})`);
  }, 60_000);

  test('only fresh holds: no waited clause', async () => {
    await seedHeldPage(engine, 'archive/new-example', 'default', 2);
    const found = await budgetLimitedFinding(engine, null);
    expect(found?.details).toMatchObject({ held: 1, waiting_over_day: 0 });
    expect(found?.message).not.toContain('waited more than a day');
  }, 60_000);
});
