/**
 * Seeds `chronicle_page_state` rows (#5876) on a brain that ran the real ledger migration: each row
 * gets a real page (the ledger's foreign keys hold), and judged automatic rows also get the
 * reservation the chronicle phase takes before each judge call.
 */
import type { BrainEngine } from '../../src/core/engine.ts';

export interface LedgerRowSeed {
  slug: string; state: 'pending' | 'skipped' | 'extracted' | 'failed'; reason?: string; trigger?: 'auto' | 'backfill';
  principal?: [string, string]; cost?: number | null; unpriced?: boolean; hoursAgo?: number;
  /** Extra judge calls (retries) for this content; each takes its own reservation. */
  retries?: number;
}

let hashSeq = 1;
export async function insertChronicleLedgerRow(engine: BrainEngine, row: LedgerRowSeed): Promise<void> {
  const page = await engine.getPage(row.slug, { sourceId: 'default' })
    ?? await engine.putPage(row.slug, { type: 'meeting', title: row.slug, compiled_truth: `Seeded meeting ${row.slug}.` }, { sourceId: 'default' });
  const pageId = Number(page.id);
  const hash = `seed-${hashSeq++}`;
  const hoursAgo = String(row.hoursAgo ?? 1);
  const judged = row.state === 'extracted' || row.state === 'failed';
  await engine.executeRaw(`INSERT INTO chronicle_page_state
    (source_id, page_id, content_hash, extractor_version, slug, state, reason, trigger, principal_kind, principal_id,
     attempts, cost_usd, unpriced, updated_at)
    VALUES ('default', $1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() - ($12 || ' hours')::interval)`,
  [pageId, hash, row.slug, row.state, row.reason ?? null, row.trigger ?? 'auto', row.principal?.[0] ?? null,
    row.principal?.[1] ?? null, judged ? 1 + (row.retries ?? 0) : 0, row.cost ?? null, row.unpriced ?? false, hoursAgo]);
  for (let i = 0; judged && (row.trigger ?? 'auto') === 'auto' && i <= (row.retries ?? 0); i++) {
    await engine.executeRaw(`INSERT INTO chronicle_judge_reservations (reserved_at, source_id, page_id, content_hash)
      VALUES (now() - ($1 || ' hours')::interval, 'default', $2, $3)`, [hoursAgo, pageId, hash]);
  }
}
