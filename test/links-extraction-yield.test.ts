/**
 * GBRA-133: managed stale link extraction gives the event loop a turn after
 * every page. PGLite statements resolve as one microtask chain, so a sync's
 * end-of-run extraction over thousands of pages otherwise held every timer
 * (and every in-process search) until the last page published.
 * Protects: a timer queued during the drain runs before each worker starts
 * its next page, so no more pages than the extraction width (1 on PGLite)
 * start within one event-loop turn.
 * Fails when: the per-page loop in extractManagedStaleLinks stops yielding,
 * so every PGLite page starts at the same heartbeat count.
 * Seams: the engine's readPageSnapshot is observed (it still runs on the
 * receiver, a transaction included) to learn when each page's derivation starts. PGLite, and Postgres with DATABASE_URL.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { extractManagedStaleLinks, MANAGED_LINK_EXTRACTION_WIDTH } from '../src/core/persistence/links-maintenance.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-links-yield-db-'));
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); rmSync(dataDir, { recursive: true, force: true });
});

const PAGES = 8;

for (const [index, backend] of backends.entries()) {
  test(`${backend}: a managed stale extraction starts no more pages per event-loop turn than its width`, async () => {
    const engine = engines[index]!;
    await engine.putPage('topics/hub', { type: 'concept', title: 'hub', compiled_truth: 'The hub.', frontmatter: {} });
    for (let i = 0; i < PAGES; i++) {
      await engine.putPage(`notes/n${i}`, { type: 'note', title: `n${i}`, compiled_truth: `Note ${i} links [[topics/hub]].`, frontmatter: {} });
    }
    await engine.executeRaw(`UPDATE pages SET links_extracted_at = NULL`);

    let beats = 0; let live = true;
    const beat = () => { beats++; if (live) setTimeout(beat, 0); };
    setTimeout(beat, 0);
    const seen = new Map<string, number>();
    const read = engine.readPageSnapshot;
    engine.readPageSnapshot = function (this: BrainEngine, slug, opts) {
      if (slug.startsWith('notes/') && !seen.has(slug)) seen.set(slug, beats);
      return read.call(this, slug, opts);
    };
    try {
      const result = await extractManagedStaleLinks(engine, { mentions: false });
      expect(result.pages).toBe(PAGES + 1);
    } finally {
      live = false;
      delete (engine as { readPageSnapshot?: unknown }).readPageSnapshot;
    }

    expect(seen.size).toBe(PAGES);
    const startedPerTurn = new Map<number, number>();
    for (const count of seen.values()) startedPerTurn.set(count, (startedPerTurn.get(count) ?? 0) + 1);
    const width = engine.kind === 'postgres' ? MANAGED_LINK_EXTRACTION_WIDTH : 1;
    expect(Math.max(...startedPerTurn.values())).toBeLessThanOrEqual(width);
  }, 60_000);
}
