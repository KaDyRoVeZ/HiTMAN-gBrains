import type { Migration } from './types.ts';
import { WRITE_ATTRIBUTION_SCHEMA_SQL } from '../persistence/attribution-schema.ts';
import { MANAGED_WRITER_GUARD_SQL } from '../persistence/writer-guard-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Foundations 1 (F1) write attribution: nullable attribution columns on pages,
// page_versions, facts, takes and timeline_entries plus the BEFORE ROW
// triggers that stamp them from the coordinator's transaction-local actor
// (DDL in src/core/persistence/attribution-schema.ts). No backfill: existing
// rows read as "unrecorded". The writer guard is re-installed so an
// attribution-only facts/takes update is not a canonical change.
export const v193: Migration = {
  version: 193,
  name: 'f1_write_attribution',
  idempotent: true,
  sql: `${WRITE_ATTRIBUTION_SCHEMA_SQL}
      ${MANAGED_WRITER_GUARD_SQL}`,
};
