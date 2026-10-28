import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); src/schema.sql
// carries the same function, byte for byte, for fresh installs.
//
// #7112: gbrain_try_jsonb(text) parses text as jsonb and returns NULL when it
// is not valid jsonb, instead of raising. It replaces the SQL/JSON `IS JSON`
// predicate and pg_input_is_valid(), both Postgres 16+, which made every
// statement that normalizes sources.config a syntax error (42601) on
// Postgres 15. It also refuses what IS JSON let through and the jsonb cast
// then rejected (a \u0000 escape), so the guarded cast can no longer raise.
// DDL only, nothing to backfill.
export const v263: Migration = {
  version: 263,
  name: 'try_jsonb_function',
  idempotent: true,
  sql: `
CREATE OR REPLACE FUNCTION gbrain_try_jsonb(input text) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE STRICT SET search_path = pg_catalog, public AS $fn$
BEGIN
  RETURN input::jsonb;
EXCEPTION WHEN data_exception THEN
  RETURN NULL;
END $fn$;
`,
};
