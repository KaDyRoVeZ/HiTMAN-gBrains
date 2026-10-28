import type { Migration } from './types.ts';
import { WRITE_ATTRIBUTION_SCHEMA_SQL } from '../persistence/attribution-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Speaker attribution: who asserted a saved fact ('user', 'assistant' or a
// named 'other' party), written by the conversation-facts extractor when
// `facts.attribution` is on (the default). NULL means attribution is unavailable (older
// facts, non-conversation text) and is compatible with either speaker in
// every dedup path. Nullable with no default: metadata-only on Postgres 11+
// and PGLite, no backfill. The facts table is created by migrations only
// (v045), so there is no schema.sql mirror. The column is canonical content
// (attribution-schema.ts), so the write-attribution trigger function is
// re-created here to include it in the content-change comparison.
export const v215: Migration = {
  version: 215,
  name: 'facts_attributed_to',
  idempotent: true,
  sql: `
    ALTER TABLE facts ADD COLUMN IF NOT EXISTS attributed_to TEXT
      CHECK (attributed_to IN ('user', 'assistant', 'other'));
    ${WRITE_ATTRIBUTION_SCHEMA_SQL}`,
};
