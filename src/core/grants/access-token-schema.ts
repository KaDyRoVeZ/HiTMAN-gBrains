/**
 * F3 (O-CEO-8, O-ENG-7): legacy bearer tokens get the OAuth client grant
 * columns. `source_grant` names the source state explicitly; NULL means the
 * row still uses the `permissions` JSONB shape: migration v202 converts every
 * such active row, and one an older binary adds converts on its next HTTP
 * read (`resolveTokenGrant`), grant write, or `auth rescope --migrate-legacy`.
 * No foreign key on `source_id`: the client FK is ON DELETE RESTRICT, and
 * tokens must not start blocking source removal.
 *
 * Migration-only, like `permissions` (v038): the schema blob's access_tokens
 * has neither, so fresh installs and upgrades both add the columns in the same
 * order (pinned by test/pglite-upgrade-replay.test.ts).
 */
export const ACCESS_TOKEN_GRANT_SCHEMA_SQL = `
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS source_grant TEXT
  CHECK (source_grant IN ('default', 'scalar', 'federated', 'none'));
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS source_id TEXT;
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS federated_read TEXT[];
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS allowed_operations TEXT[];
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS takes_holders TEXT[];
ALTER TABLE access_tokens ADD COLUMN IF NOT EXISTS grant_revision INTEGER NOT NULL DEFAULT 0;
`;
