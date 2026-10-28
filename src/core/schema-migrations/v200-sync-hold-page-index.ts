import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #5988 read-time hold signals: get_page, search and query look up the Git
// holds of the pages they return by page id in one indexed read
// (src/core/persistence/held-reads.ts). Partial: only `sync-hold` rows.
const INDEX_SQL = `CREATE INDEX IF NOT EXISTS op_checkpoints_sync_hold_page_idx
      ON op_checkpoints ((completed_keys->0->>'page_id')) WHERE op = 'sync-hold';`;

export const v200: Migration = {
  version: 200,
  name: 'sync_hold_page_index',
  idempotent: true,
  sql: INDEX_SQL,
  sqlFor: { postgres: `SET LOCAL statement_timeout = '30s'; SET LOCAL lock_timeout = '2s';\n      ${INDEX_SQL}` },
};
