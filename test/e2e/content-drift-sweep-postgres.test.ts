/**
 * #7117: the content-drift sweep under a statement_timeout, on real Postgres.
 *
 * Protects: every content-drift statement is bounded to one batch of chunk
 * rows, so a cancel loses at most the batch it hit. Earlier batches stay
 * committed, the sweep's cursor stays before the cancelled batch, the failure
 * is reported (state, error, saved last_error) instead of swallowed, and the
 * next run resumes there and completes the pass. Grandfathered (NULL hash),
 * embed_skip, archived-source and deleted-page rows stay untouched.
 * Regression it catches: one UPDATE over all of content_chunks; any cancel
 * rolled the whole pass back and the next run started from scratch.
 * Seam: a second connection holds a row lock on the last drifted chunk, so the
 * statement that reaches it waits until a 1.5 s statement_timeout cancels it,
 * as the pool's 5 min timeout cancels a whole-table scan on a large brain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getConn } from './helpers.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { installFixtureChunks } from '../helpers/page-projection.ts';

const d = hasDatabase() ? describe : describe.skip;
const url = process.env.DATABASE_URL;
const previousTimeout = process.env.GBRAIN_STATEMENT_TIMEOUT;
const FILLER_PAGES = 60;
const CHUNKS_PER_PAGE = 100;
/** Row ranks (0-based, id order) of the drifted filler chunks; the batch size is 5000. */
const EARLY = [10, 2000, 4500];
const LATE = [5200];

let engine: PostgresEngine;
let slow: PostgresEngine;
let lockedId: number;
let release: (() => void) | null = null;

async function vectorKept(id: number): Promise<boolean> {
  const [row] = await engine.executeRaw<{ kept: boolean }>('SELECT embedding IS NOT NULL AS kept FROM content_chunks WHERE id = $1', [id]);
  return row!.kept;
}

async function idAtRank(rank: number): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM content_chunks ORDER BY id OFFSET $1 LIMIT 1', [rank]);
  return Number(row!.id);
}

/** Embed chunk rows with a zero vector and a stored hash (`hash` null = grandfathered). */
async function embedRows(ids: number[], hash: string | null): Promise<void> {
  const [{ dim }] = await engine.executeRaw<{ dim: number }>(
    "SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0");
  await engine.executeRaw(
    `UPDATE content_chunks SET embedding = ('[' || array_to_string(array_fill(0.1::real, ARRAY[$1::int]), ',') || ']')::vector,
       embedded_at = now(), embedded_text_hash = $2 WHERE id = ANY($3::int[])`, [dim, hash, ids]);
}

async function onlyChunk(slug: string, sourceId = 'default'): Promise<number> {
  const [row] = await engine.executeRaw<{ id: number }>(
    'SELECT cc.id FROM content_chunks cc JOIN pages p ON p.id = cc.page_id WHERE p.slug = $1 AND p.source_id = $2', [slug, sourceId]);
  return Number(row!.id);
}

/** Excluded rows first (low ids, inside the first batch), then the filler corpus with a few drifted rows. */
async function seed(): Promise<{ excluded: number[]; early: number[]; late: number[] }> {
  const single = async (slug: string, sourceId = 'default') => {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug }, { sourceId });
    await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: `text of ${slug}`, chunk_source: 'compiled_truth', token_count: 3 }], { sourceId });
    return onlyChunk(slug, sourceId);
  };
  const legacy = await single('legacy');
  const skipped = await single('skipped');
  await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"embed_skip": true}'::jsonb WHERE slug = 'skipped'`);
  const deleted = await single('deleted');
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('shelf', 'shelf', '{"federated":true}'::jsonb)`);
  const archived = await single('archived', 'shelf');
  await embedRows([legacy], null);
  await embedRows([skipped, deleted, archived], 'hash-of-an-earlier-text');
  await engine.softDeletePage('deleted', { sourceId: 'default' });
  await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = 'shelf'`);

  for (let i = 0; i < FILLER_PAGES; i++) await engine.putPage(`filler-${i}`, { type: 'note', title: `filler ${i}`, compiled_truth: 'filler' });
  await engine.executeRaw(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, token_count)
     SELECT p.id, g, 'filler chunk ' || p.slug || ' ' || g, 3 FROM pages p, generate_series(0, $1::int - 1) g
      WHERE p.slug LIKE 'filler-%' ORDER BY p.id, g`, [CHUNKS_PER_PAGE]);
  const total = 4 + FILLER_PAGES * CHUNKS_PER_PAGE;
  const early = await Promise.all(EARLY.map(idAtRank));
  const late = await Promise.all(LATE.map(idAtRank));
  lockedId = await idAtRank(total - 1);
  await embedRows([...early, ...late, lockedId], 'hash-of-an-earlier-text');
  return { excluded: [legacy, skipped, deleted, archived], early, late };
}

/** Hold a row lock on the last drifted chunk from another connection until release(). */
async function lockLastDrifted(): Promise<void> {
  let locked!: () => void;
  const held = new Promise<void>(resolve => { locked = resolve; });
  const done = new Promise<void>(resolve => { release = resolve; });
  void getConn().begin(async sql => {
    await sql`SELECT id FROM content_chunks WHERE id = ${lockedId} FOR UPDATE`;
    locked();
    await done;
  });
  await held;
}

d('#7117 content-drift sweep under statement_timeout (Postgres)', () => {
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(url!);
    engine = await setupDB();
    process.env.GBRAIN_STATEMENT_TIMEOUT = '1500ms';
    slow = new PostgresEngine();
    await slow.connect({ engine: 'postgres', database_url: url!, poolSize: 3 });
  }, 60_000);

  afterAll(async () => {
    release?.();
    if (previousTimeout === undefined) delete process.env.GBRAIN_STATEMENT_TIMEOUT; else process.env.GBRAIN_STATEMENT_TIMEOUT = previousTimeout;
    await slow?.disconnect();
    await teardownDB();
  });

  beforeEach(async () => {
    release?.();
    release = null;
    await engine.executeRaw('TRUNCATE pages CASCADE');
    await engine.executeRaw("DELETE FROM sources WHERE id = 'shelf'");
    await engine.executeRaw("DELETE FROM config WHERE key LIKE 'embed.content_drift_sweep.%'");
  });

  test('a cancelled drift pass keeps the batches before the cancel', async () => {
    const { excluded, early, late } = await seed();
    await lockLastDrifted();
    const error = await slow.invalidateContentDriftEmbeddings().then(() => null, (e: unknown) => e);
    release!();
    expect(String((error as Error | null)?.message)).toMatch(/statement timeout/);
    for (const id of early) expect(await vectorKept(id)).toBe(false);
    for (const id of [...late, lockedId, ...excluded]) expect(await vectorKept(id)).toBe(true);
  }, 60_000);

  test('the sweep reports the cancel, keeps its cursor, and the next run completes the pass', async () => {
    const { runContentDriftSweep, readContentDriftSweepStates } = await import('../../src/core/content-drift-sweep.ts');
    const { excluded, early, late } = await seed();
    await lockLastDrifted();
    const first = await runContentDriftSweep(slow);
    release!();
    expect(first.state).toBe('failed');
    expect(first.error).toMatch(/statement timeout/);
    expect(first).toMatchObject({ batches: 1, checked: 5000, drifted: early.length, cursor: await idAtRank(4999) });
    const [saved] = await readContentDriftSweepStates(engine);
    expect(saved!.state).toMatchObject({ cursor: first.cursor, pass_checked: 5000, pass_drifted: early.length, last_completed_at: null });
    expect(saved!.state.last_error?.message).toMatch(/statement timeout/);
    for (const id of early) expect(await vectorKept(id)).toBe(false);
    for (const id of [...late, lockedId]) expect(await vectorKept(id)).toBe(true);

    const second = await runContentDriftSweep(slow);
    expect(second).toMatchObject({ state: 'complete', batches: 2, checked: 4 + FILLER_PAGES * CHUNKS_PER_PAGE - 5000, drifted: late.length + 1, cursor: 0 });
    for (const id of [...early, ...late, lockedId]) expect(await vectorKept(id)).toBe(false);
    for (const id of excluded) expect(await vectorKept(id)).toBe(true);
    const [after] = await readContentDriftSweepStates(engine);
    expect(after!.state).toMatchObject({ cursor: 0, last_pass_checked: 4 + FILLER_PAGES * CHUNKS_PER_PAGE, last_pass_drifted: early.length + late.length + 1, last_error: null });
  }, 60_000);
});
