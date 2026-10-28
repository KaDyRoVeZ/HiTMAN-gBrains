import type { Migration } from './types.ts';
import { PERSISTENCE_GRADUATION_SCHEMA_SQL } from '../persistence/graduation-schema.ts';

// Engine graduation (PGLite -> Postgres): the `persistence_graduation`
// singleton both engines use as their own custody record (source:
// quiesced -> cutover; target: copying -> verified -> authoritative), and the
// `gbrain_graduation_fence()` trigger function the run attaches to every
// target table until the authority transaction. DDL in
// src/core/persistence/graduation-schema.ts. The table is schema-owned: never
// copied, digested or compared.
export const v201: Migration = {
  version: 201,
  name: 'persistence_graduation',
  idempotent: true,
  sql: PERSISTENCE_GRADUATION_SCHEMA_SQL,
};
