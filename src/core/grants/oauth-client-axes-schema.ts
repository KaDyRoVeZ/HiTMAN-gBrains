/**
 * Two OAuth client grant axes that legacy tokens already had: an explicit
 * no-source grant and a per-client takes-holder allow-list.
 *
 * `source_grant` is NULL (the source grant is `source_id` + `federated_read`)
 * or `none` (the client holds no source: `source_id` NULL, `federated_read`
 * empty, every read and write refused). `takes_holders` NULL is the default
 * `['world']`; `[]` hides every take.
 *
 * The schema blob declares both after `created_at` (src/schema.sql), so a
 * fresh install and an upgrade, which appends them here, end with the same
 * column order.
 */
export const OAUTH_CLIENT_GRANT_AXES_SQL = `
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS source_grant TEXT
  CHECK (source_grant IN ('none'));
ALTER TABLE oauth_clients ADD COLUMN IF NOT EXISTS takes_holders TEXT[];
`;
