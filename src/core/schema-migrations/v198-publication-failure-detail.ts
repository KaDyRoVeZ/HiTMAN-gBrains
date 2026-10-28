import type { Migration } from './types.ts';
import { MANAGED_WRITER_GUARD_FUNCTION_SQL } from '../persistence/writer-guard-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #5974: a refused publication names what refused it. The managed-writer guard
// function is replaced (no table lock, as in v197) so each RAISE carries TABLE/SCHEMA, a
// CONSTRAINT='managed_writer_guard:<branch>' marker and a JSON DETAIL with the
// operation and source relationship (no row values). persistence_requests gains
// error_detail, the bounded structured failure (publication-failure.ts) that
// survives recovery and compaction. Column-only and nullable; like v178 it is
// migration-created on PGLite and no index references it.
export const v198: Migration = {
  version: 198,
  name: 'publication_failure_detail',
  idempotent: true,
  sql: `
      ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS error_detail jsonb;
      ${MANAGED_WRITER_GUARD_FUNCTION_SQL}`,
};
