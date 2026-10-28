import type { Migration } from './types.ts';
import { PLANNER_STATS_SCHEMA_SQL } from '../planner-stats-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Foundations 1 (F4b) planner-statistics accounting: the planner_stats_deltas /
// planner_stats_state tables and the AFTER STATEMENT transition-table triggers
// on the six hot tables (DDL in src/core/planner-stats-schema.ts). PGLite only:
// Postgres has autovacuum, so this migration is a no-op there and Postgres write
// paths gain no trigger. Not in schema.sql: facts and takes are created by
// migrations, so the PGLite bootstrap blob cannot carry their triggers, and every
// fresh PGLite brain runs this migration anyway.
export const v196: Migration = {
  version: 196,
  name: 'f4_planner_stats',
  idempotent: true,
  sql: '',
  sqlFor: { pglite: PLANNER_STATS_SCHEMA_SQL },
};
