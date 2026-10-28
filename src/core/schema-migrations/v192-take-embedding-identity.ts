import type { Migration } from './types.ts';
import { MANAGED_WRITER_GUARD_SQL } from '../persistence/writer-guard-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #5885: a take vector records the model and the claim text it was computed
// from, like facts (v166), so a model swap or a claim edit makes it stale
// instead of silently searchable. Existing vectors keep NULL provenance and
// count as stale until re-embedded. The writer guard treats both columns as
// physical projection on takes too (re-installed here).
export const v192: Migration = {
  version: 192,
  name: 'take_embedding_identity',
  idempotent: true,
  sql: `ALTER TABLE takes ADD COLUMN IF NOT EXISTS embedding_model TEXT;
      ALTER TABLE takes ADD COLUMN IF NOT EXISTS embedded_text_hash TEXT;
      ${MANAGED_WRITER_GUARD_SQL}`,
};
