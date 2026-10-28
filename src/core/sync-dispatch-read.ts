/**
 * GBRA-133 (PR 2b): the rows a single-source CLI sync reads to choose its route before it takes the source's drain lease,
 * in one round trip: the source row (existence, archive state, config, incarnation, local path), whether it is claimed
 * and has a company-brain receipt, and the brain's persistence mode. Before, the source resolver, the company profile
 * (twice), the managed mode (up to three times), the content-directory anchor and the connector check each read their
 * part in turn.
 *
 * The read is scoped to routing (`withSyncDispatchRead` around one CLI run, never --all or --watch). The scope ends for
 * good where the work starts (perform.ts once the route is chosen, sync-delegate.ts before the hand-off to the serve), so
 * every read under the lease (the managed pass reads the mode, the profile and the source rows again) and every read
 * after a write stays live. Outside the scope, after its end, or when the combined read fails, each reader runs its own
 * query as before.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { BrainEngine } from './engine.ts';
import { MANAGED_MODE_SQL, managedModeFromRows } from './persistence/managed-mode.ts';

export interface SyncDispatchRow {
  /** Null when no source has the id. */
  id: string | null; archived: boolean | null; config: unknown; incarnation: string | null; local_path: string | null;
  claimed: boolean; company_receipt: boolean;
  /** `enabled` of every row `MANAGED_MODE_SQL` returns. */
  modes: unknown[];
}

const SQL = `SELECT s.id, s.archived, s.config, s.incarnation::text AS incarnation, s.local_path,
  EXISTS(SELECT 1 FROM persistence_source_bindings b WHERE b.source_id=s.id AND b.source_incarnation=s.incarnation) AS claimed,
  EXISTS(SELECT 1 FROM source_ingestion_receipts r WHERE r.source_id=s.id AND r.source_incarnation=s.incarnation AND r.profile='company-brain') AS company_receipt,
  (SELECT COALESCE(jsonb_agg(m.enabled), '[]'::jsonb) FROM (${MANAGED_MODE_SQL}) m) AS modes
  FROM (SELECT $1::text AS want) w LEFT JOIN sources s ON s.id=w.want`;

const scope = new AsyncLocalStorage<{ engine: object; reads: Map<string, Promise<SyncDispatchRow | undefined>>; ended: boolean }>();

/** Runs `fn` with routing reads of `engine` answered from one shared read per source. */
export function withSyncDispatchRead<T>(engine: object, fn: () => Promise<T>): Promise<T> {
  return scope.run({ engine, reads: new Map(), ended: false }, fn);
}

/** Ends the routing scope for the rest of the run: every later read is live. */
export function endSyncDispatchRead(): void {
  const store = scope.getStore();
  if (store) store.ended = true;
}

/** The source's routing row inside the scope (read once, then shared); undefined outside it or when the read failed. */
export function syncDispatchRow(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<SyncDispatchRow | undefined> | undefined {
  const store = scope.getStore();
  if (!store || store.ended || store.engine !== engine) return undefined;
  let read = store.reads.get(sourceId);
  if (!read) {
    read = engine.executeRaw<SyncDispatchRow>(SQL, [sourceId]).then(rows => rows[0], () => undefined);
    store.reads.set(sourceId, read);
  }
  return read;
}

/** A routing row's persistence mode under `readManagedMode`'s contract: a malformed singleton refuses the same way. */
export function dispatchManagedMode(row: SyncDispatchRow): boolean {
  return managedModeFromRows(row.modes.map(enabled => ({ enabled }))).enabled;
}
