/**
 * #5181 on Postgres: `reindex --markdown` sizes its writer pool from the
 * pending total. A full batch is exactly the auto-concurrency threshold
 * (100), so sizing from the batch length kept every run at one writer no
 * matter how many pages were pending.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { runReindex } from '../../src/commands/reindex.ts';
import { DEFAULT_PARALLEL_WORKERS } from '../../src/core/sync-concurrency.ts';

const RUN = hasDatabase();
const describeE2E = RUN ? describe : describe.skip;
const PAGES = 120;

describeE2E('reindex --markdown auto-concurrency (Postgres, #5181)', () => {
  beforeAll(async () => {
    await setupDB();
    const engine = getEngine();
    for (let i = 0; i < PAGES; i++) {
      const body = `---\ntitle: Reindex note ${i}\ntype: note\n---\nReindex worker sizing body ${i}.\n`;
      await importFromContent(engine, `notes/reindex-${String(i).padStart(3, '0')}`, body, { noEmbed: true });
    }
    await engine.executeRaw("UPDATE pages SET chunker_version = 0 WHERE slug LIKE 'notes/reindex-%'");
  }, 120_000);
  afterAll(async () => { await teardownDB(); });

  test('more than 100 pending pages use the auto worker count and reindex every page', async () => {
    const result = await runReindex(getEngine(), ['--markdown', '--no-embed']);
    expect(result.pending).toBe(PAGES);
    expect(result.workers).toBe(DEFAULT_PARALLEL_WORKERS);
    expect(result.reindexed).toBe(PAGES);
    expect(result.failed).toBe(0);
    expect(result.pendingAfter).toBe(0);
  }, 120_000);

  test('a run capped at 100 pages stays on one writer', async () => {
    await getEngine().executeRaw("UPDATE pages SET chunker_version = 0 WHERE slug LIKE 'notes/reindex-%'");
    const result = await runReindex(getEngine(), ['--markdown', '--no-embed', '--limit', '100']);
    expect(result.workers).toBe(1);
    expect(result.reindexed).toBe(100);
  }, 120_000);
});
