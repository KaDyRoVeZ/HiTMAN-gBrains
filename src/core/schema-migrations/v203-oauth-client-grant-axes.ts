import { OAUTH_CLIENT_GRANT_AXES_SQL } from '../grants/oauth-client-axes-schema.ts';
import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// OAuth clients gain the explicit no-source grant (`source_grant = 'none'`)
// and a per-client takes-holder allow-list (fragment
// src/core/grants/oauth-client-axes-schema.ts). Additive and metadata-only:
// every existing client keeps NULL in both, which is its current grant.
export const v203: Migration = {
  version: 203,
  name: 'oauth_client_grant_axes',
  idempotent: true,
  sql: OAUTH_CLIENT_GRANT_AXES_SQL,
};
