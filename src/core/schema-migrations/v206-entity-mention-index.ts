import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Entity mention index (src/core/mentions/). Additive only; no existing row
// is rewritten:
//   - page_aliases gains `origin` (frontmatter | declared | subject; existing
//     rows read as frontmatter), `case_sensitive` and `alias_text` (the alias
//     as written, for case-sensitive matching). The unique key widens to
//     include origin, so a frontmatter alias and the same derived alias of one
//     page coexist and readers apply precedence frontmatter > declared > subject.
//   - page_mention_state: per page, the content revision, mention extractor
//     version and source generation its mention links were published at, and
//     the revision its derived aliases were refreshed at.
//   - mention_gazetteer_entries: the last saved gazetteer entry set per source,
//     diffed on the next pass to mark only affected pages due.
//   - mention_index_status: one row per source (generation, state, pending
//     count, last pass), read by entity cards and get_backlinks as `coverage`.
// page_aliases carries the managed-writer guard; ALTER TABLE fires no row
// trigger, so the column adds need no coordinated write.
export const v206: Migration = {
  version: 206,
  name: 'entity_mention_index',
  idempotent: true,
  sql: `
    ALTER TABLE page_aliases ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'frontmatter'
      CHECK (origin IN ('frontmatter','declared','subject'));
    ALTER TABLE page_aliases ADD COLUMN IF NOT EXISTS case_sensitive BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE page_aliases ADD COLUMN IF NOT EXISTS alias_text TEXT;
    DO $alias_origin$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'page_aliases_origin_uniq' AND conrelid = 'page_aliases'::regclass) THEN
        ALTER TABLE page_aliases ADD CONSTRAINT page_aliases_origin_uniq UNIQUE (source_id, alias_norm, slug, origin);
      END IF;
      ALTER TABLE page_aliases DROP CONSTRAINT IF EXISTS page_aliases_uniq;
    END $alias_origin$;
    CREATE TABLE IF NOT EXISTS page_mention_state (
      page_id INTEGER PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      mention_revision UUID,
      mention_version INTEGER,
      mention_generation BIGINT,
      mentions_scanned_at TIMESTAMPTZ,
      alias_revision UUID,
      alias_version INTEGER,
      aliases_refreshed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS page_mention_state_source_idx ON page_mention_state (source_id, mention_version);
    CREATE TABLE IF NOT EXISTS mention_gazetteer_entries (
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      name_norm TEXT NOT NULL,
      target_slug TEXT NOT NULL,
      case_sensitive BOOLEAN NOT NULL DEFAULT false,
      PRIMARY KEY (source_id, name_norm, target_slug, case_sensitive)
    );
    CREATE TABLE IF NOT EXISTS mention_index_status (
      source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
      generation BIGINT NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('complete','pending','disabled','failed')),
      pending INTEGER NOT NULL DEFAULT 0,
      counted_at TIMESTAMPTZ,
      last_pass_at TIMESTAMPTZ,
      policy_fingerprint TEXT,
      error TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    DO $rls$ BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolbypassrls) THEN
        ALTER TABLE page_mention_state ENABLE ROW LEVEL SECURITY;
        ALTER TABLE mention_gazetteer_entries ENABLE ROW LEVEL SECURITY;
        ALTER TABLE mention_index_status ENABLE ROW LEVEL SECURITY;
      END IF;
    END $rls$;
  `,
};
