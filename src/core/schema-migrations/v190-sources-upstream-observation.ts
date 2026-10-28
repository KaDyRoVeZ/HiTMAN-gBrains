import type { Migration } from './types.ts';

// #5255/#5176 (O-DX-8): the last upstream observation per source, recorded by
// sync from the checkout's own Git state (the upstream ref, the time it was
// last fetched or pushed, and how many upstream commits the synced commit
// lacks). doctor sync_freshness reads these columns, so a remote doctor needs
// no subprocess. Not covered by managed_writer_guard: they are observations,
// not checkpoints. ADD COLUMN with a NULL default is metadata-only on both
// engines. Mirror lives in schema.sql (fresh-install path).
// Lane B placeholder number: the fix-wave-8 integrator renumbers it.
export const v190: Migration = {
  version: 190,
  name: 'sources_upstream_observation',
  idempotent: true,
  sql: `
    ALTER TABLE sources ADD COLUMN IF NOT EXISTS upstream_checked_at TIMESTAMPTZ;
    ALTER TABLE sources ADD COLUMN IF NOT EXISTS upstream_commit TEXT;
    ALTER TABLE sources ADD COLUMN IF NOT EXISTS upstream_behind INTEGER;
  `,
};
