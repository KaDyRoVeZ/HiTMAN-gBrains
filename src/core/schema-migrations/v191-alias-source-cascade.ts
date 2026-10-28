import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #5094: page_aliases and slug_aliases carry source_id but had no foreign key,
// so `sources remove` left their rows behind (doctor dangling_aliases). This
// deletes alias rows whose source no longer exists, then adds
// `FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE` to both.
//
// Managed brains: both tables carry managed_writer_guard, which refuses a
// delete unless the row's source is in gbrain.write_sources, so the GC grants
// exactly the orphan rows' source ids for this transaction and restores the
// previous value. The FK is added NOT VALID (no full scan under the ADD lock)
// and validated by the handler in its own statement. entity_identities needs
// nothing: its page_id FK already cascades when a source's pages go.
const ALIAS_TABLES = ['page_aliases', 'slug_aliases'] as const;

export const v191: Migration = {
  version: 191,
  name: 'alias_source_cascade',
  idempotent: true,
  sql: `
    DO $alias_gc$
    DECLARE orphan_sources jsonb; previous text;
    BEGIN
      SELECT COALESCE(jsonb_agg(DISTINCT o.source_id), '[]'::jsonb) INTO orphan_sources FROM (
        SELECT a.source_id FROM page_aliases a WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = a.source_id)
        UNION
        SELECT a.source_id FROM slug_aliases a WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = a.source_id)
      ) o;
      IF orphan_sources <> '[]'::jsonb THEN
        previous := current_setting('gbrain.write_sources', true);
        PERFORM set_config('gbrain.write_sources', orphan_sources::text, true);
        DELETE FROM page_aliases a WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = a.source_id);
        DELETE FROM slug_aliases a WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = a.source_id);
        PERFORM set_config('gbrain.write_sources', COALESCE(previous, ''), true);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'page_aliases_source_fk' AND conrelid = 'page_aliases'::regclass) THEN
        ALTER TABLE page_aliases ADD CONSTRAINT page_aliases_source_fk
          FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE NOT VALID;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'slug_aliases_source_fk' AND conrelid = 'slug_aliases'::regclass) THEN
        ALTER TABLE slug_aliases ADD CONSTRAINT slug_aliases_source_fk
          FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE NOT VALID;
      END IF;
    END $alias_gc$;
  `,
  handler: async (engine) => {
    for (const table of ALIAS_TABLES) {
      const [constraint] = await engine.executeRaw<{ convalidated: boolean }>(
        `SELECT convalidated FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass`, [`${table}_source_fk`, table]);
      if (constraint && !constraint.convalidated) {
        await engine.runMigration(190, `ALTER TABLE ${table} VALIDATE CONSTRAINT ${table}_source_fk`);
      }
    }
  },
  verify: async (engine) => {
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_constraint
        WHERE conname IN ('page_aliases_source_fk', 'slug_aliases_source_fk') AND contype = 'f' AND convalidated`);
    return Number(rows[0]?.n ?? 0) === ALIAS_TABLES.length;
  },
};
