import type { Migration } from './types.ts';
import { LINK_ASSERTION_TENSE_SQL, LINK_TEMPORAL_SCHEMA_SQL } from '../link-temporal-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Temporal typed edges: links.assertion_tense, link_transitions (dated
// evidence), link_relationships (derived state per relationship and scope),
// link_edge_proposals and graph_generation_seq. DDL in
// src/core/link-temporal-schema.ts. Additive only: the links identity and its
// ON CONFLICT targets are unchanged, so writers from the previous release keep
// working; relationships without a state row read as live.
export const v204: Migration = {
  version: 204,
  name: 'links_temporal_state',
  idempotent: true,
  sql: `${LINK_ASSERTION_TENSE_SQL}
${LINK_TEMPORAL_SCHEMA_SQL}`,
};
