import { ACCESS_TOKEN_GRANT_SCHEMA_SQL } from '../grants/access-token-schema.ts';
import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// F3: the unified grant columns on access_tokens (fragment
// src/core/grants/access-token-schema.ts). Additive and metadata-only; every
// existing row keeps source_grant NULL and is migrated lazily on its next grant
// write, so no token is re-issued.
export const v195: Migration = {
  version: 195,
  name: 'f3_access_token_grants',
  idempotent: true,
  sql: ACCESS_TOKEN_GRANT_SCHEMA_SQL,
};
