/**
 * Retrieval feedback storage on PGLite and real Postgres: array binds, the
 * single-statement rating upsert, concurrent ratings on one element (no lost
 * update), revision handling and the feedback ranking read.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { applyRatings, insertRetrievalEvents, readWeights } from '../../src/core/feedback/store.ts';
import { mintAnswerId } from '../../src/core/feedback/record.ts';
import { applyFeedbackStage } from '../../src/core/search/feedback-boost.ts';
import { _resetFeedbackSettingsCacheForTests } from '../../src/core/feedback/settings.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const SOURCE = 'feedback-parity';
const SLUGS = ['notes/fp-a', 'notes/fp-b'];

for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`${kind}: retrieval feedback storage`, () => {
    let engine: BrainEngine;
    const hashes = new Map<string, string>();

    beforeAll(async () => {
      engine = kind === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
      if (kind === 'postgres') assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
      await engine.connect(kind === 'postgres' ? { database_url: process.env.DATABASE_URL! } : {});
      await engine.initSchema();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SOURCE]);
      await engine.executeRaw('DELETE FROM retrieval_weights WHERE source_id = $1', [SOURCE]);
      for (const slug of SLUGS) {
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `body of ${slug}` }, { sourceId: SOURCE });
        const [row] = await engine.executeRaw<{ content_hash: string }>(
          'SELECT content_hash FROM pages WHERE slug = $1 AND source_id = $2', [slug, SOURCE]);
        hashes.set(slug, row!.content_hash);
      }
      await engine.setConfig('feedback.enabled', 'true');
      _resetFeedbackSettingsCacheForTests();
    }, 60_000);

    afterAll(async () => {
      await engine.executeRaw('DELETE FROM retrieval_weights WHERE source_id = $1', [SOURCE]);
      await engine.disconnect();
    });

    async function event(): Promise<string> {
      const id = mintAnswerId();
      await insertRetrievalEvents(engine, [{
        id, client_id: 'local', op: 'query',
        pages: SLUGS.map((slug, rank) => ({ source_id: SOURCE, slug, content_hash: hashes.get(slug)!, rank, cited: false })),
        links: [{ source_id: SOURCE, edge_key: 'notes/fp-a|mentions|notes/fp-b', to_slug: 'notes/fp-b' }],
      }]);
      return id;
    }

    test('a rating is applied once per element and moves the weight by the moving average', async () => {
      const id = await event();
      const target = { kind: 'page' as const, source_id: SOURCE, key: 'notes/fp-a', rating: 5, content_hash: hashes.get('notes/fp-a')! };
      const first = await applyRatings(engine, { eventId: id, clientId: 'local', signal: 'explicit', alpha: 0.1, targets: [target] });
      const again = await applyRatings(engine, { eventId: id, clientId: 'local', signal: 'explicit', alpha: 0.1, targets: [target] });
      expect(first[0]!.newly_applied).toBe(true);
      expect(again[0]!.newly_applied).toBe(false);
      const w = await readWeights(engine, 'page', [{ source_id: SOURCE, key: 'notes/fp-a' }]);
      expect(w.get(`${SOURCE}:notes/fp-a`)).toBeCloseTo(0.55, 4);
    });

    test('concurrent ratings from different answers on one element both land', async () => {
      await engine.executeRaw(`DELETE FROM retrieval_weights WHERE source_id = $1 AND element_key = 'notes/fp-b'`, [SOURCE]);
      const ids = await Promise.all(Array.from({ length: 6 }, () => event()));
      await Promise.all(ids.map(id => applyRatings(engine, {
        eventId: id, clientId: 'local', signal: 'explicit', alpha: 0.1,
        targets: [{ kind: 'page', source_id: SOURCE, key: 'notes/fp-b', rating: 1, content_hash: hashes.get('notes/fp-b')! }],
      })));
      let expected = 0.5;
      for (let i = 0; i < 6; i++) expected += 0.1 * (0 - expected);
      const w = await readWeights(engine, 'page', [{ source_id: SOURCE, key: 'notes/fp-b' }]);
      expect(w.get(`${SOURCE}:notes/fp-b`)).toBeCloseTo(expected, 3);
      const [row] = await engine.executeRaw<{ updates: number }>(
        `SELECT updates FROM retrieval_weights WHERE source_id = $1 AND element_key = 'notes/fp-b'`, [SOURCE]);
      expect(Number(row!.updates)).toBe(6);
    });

    test('the ranking read stamps the retrieved revision and boosts by the learned weight', async () => {
      const [a] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2', ['notes/fp-a', SOURCE]);
      const [b] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2', ['notes/fp-b', SOURCE]);
      const rows = [
        { slug: 'notes/fp-b', page_id: Number(b!.id), score: 0.9, source_id: SOURCE },
        { slug: 'notes/fp-a', page_id: Number(a!.id), score: 0.85, source_id: SOURCE },
      ] as never[];
      const out = await applyFeedbackStage(engine, rows, { reranked: false }) as Array<{ slug: string; content_hash?: string }>;
      expect(out.map(r => r.slug)).toEqual(['notes/fp-a', 'notes/fp-b']);
      expect(out[0]!.content_hash).toBe(hashes.get('notes/fp-a'));
    });
  });
}
