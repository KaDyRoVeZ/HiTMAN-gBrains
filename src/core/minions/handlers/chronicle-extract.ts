/**
 * `chronicle_extract` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';
import { UnrecoverableError } from '../errors.ts';

/**
 * v0.42.x (#2390) — Life Chronicle event extraction for one page. Nothing
 * enqueues it since #5876 (write decisions and backfill are ledger rows the
 * `chronicle` cycle phase executes); it drains jobs queued by older releases
 * through the same executor, so they get the ledger, the BudgetTracker scope
 * (`chronicle:legacy` unless the job names its trigger), snapshot integrity
 * and reconciliation. Content already extracted is never paid for again; a
 * job whose `content_hash` no longer matches the page is superseded.
 * Failures are failures (D5): a provider error throws (retried with
 * backoff); a missing provider, no_pricing, a budget stop, truncation and
 * malformed output fail the job unrecoverably so its idempotency key is
 * released; only a genuine empty answer completes as `no_events`.
 * #3387: registered via registerBuiltinJob (gateway-refresh wrap).
 */
export function makeChronicleExtractHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const slug = typeof job.data.slug === 'string' ? job.data.slug : undefined;
    if (!slug) throw new Error('chronicle_extract job requires data.slug');
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : 'default';
    const { runChronicleJob } = await import('../../chronicle/job.ts');
    const result = await runChronicleJob(engine, {
      slug, sourceId,
      contentHash: typeof job.data.content_hash === 'string' ? job.data.content_hash : undefined,
      trigger: job.data.trigger === 'auto' ? 'auto' : job.data.trigger === 'backfill' ? 'backfill' : 'legacy',
      signal: (job as { signal?: AbortSignal }).signal,
    });
    if (result.status === 'failed') {
      if (result.retry) throw new Error(`chronicle_extract ${slug}: ${result.reason}`);
      throw new UnrecoverableError(`chronicle_extract ${slug}: ${result.reason}`);
    }
    return result;
  };
}
