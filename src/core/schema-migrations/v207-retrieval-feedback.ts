import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Use-attributed retrieval feedback (src/core/feedback/). An answer
// (query/search/think/synthesize/recall page arm) records the pages it used,
// each with the content_hash of the revision it retrieved, plus the typed
// edges on its relational paths. Ratings (explicit `rate_answer`, implicit
// citation) move per-element weights with a bounded moving average; the
// search ranking stage reads them. Neutral weight is 0.5, so a brain with no
// feedback ranks exactly as before. Keys are logical (source_id + slug, or
// source_id + 'from|type|to') because link rows are re-created by extraction.
// No query text is stored. Created empty; plain CREATE INDEX is instant.
// Keep in sync with src/schema.sql.
export const RETRIEVAL_FEEDBACK_SQL = `
      CREATE TABLE IF NOT EXISTS retrieval_events (
        id          TEXT PRIMARY KEY,
        client_id   TEXT NOT NULL DEFAULT 'local',
        op          TEXT NOT NULL CHECK (op IN ('query','search','think','synthesize','recall')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS retrieval_events_time_idx ON retrieval_events (created_at);
      CREATE TABLE IF NOT EXISTS retrieval_event_pages (
        event_id      TEXT NOT NULL REFERENCES retrieval_events(id) ON DELETE CASCADE,
        source_id     TEXT NOT NULL,
        slug          TEXT NOT NULL,
        content_hash  TEXT,
        rank          INTEGER NOT NULL,
        cited         BOOLEAN NOT NULL DEFAULT false,
        PRIMARY KEY (event_id, source_id, slug)
      );
      CREATE TABLE IF NOT EXISTS retrieval_event_links (
        event_id   TEXT NOT NULL REFERENCES retrieval_events(id) ON DELETE CASCADE,
        source_id  TEXT NOT NULL,
        edge_key   TEXT NOT NULL,
        to_slug    TEXT NOT NULL,
        PRIMARY KEY (event_id, source_id, edge_key, to_slug)
      );
      CREATE TABLE IF NOT EXISTS retrieval_feedback (
        event_id       TEXT NOT NULL REFERENCES retrieval_events(id) ON DELETE CASCADE,
        signal         TEXT NOT NULL CHECK (signal IN ('explicit','cited')),
        element_kind   TEXT NOT NULL CHECK (element_kind IN ('page','link')),
        source_id      TEXT NOT NULL,
        element_key    TEXT NOT NULL,
        client_id      TEXT NOT NULL DEFAULT 'local',
        rating         SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
        weight_before  REAL NOT NULL,
        weight_after   REAL NOT NULL,
        applied_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (event_id, signal, element_kind, source_id, element_key)
      );
      CREATE INDEX IF NOT EXISTS retrieval_feedback_client_time_idx
        ON retrieval_feedback (client_id, applied_at DESC);
      CREATE TABLE IF NOT EXISTS retrieval_weights (
        source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        element_kind  TEXT NOT NULL CHECK (element_kind IN ('page','link')),
        element_key   TEXT NOT NULL,
        weight        REAL NOT NULL DEFAULT 0.5 CHECK (weight >= 0 AND weight <= 1),
        content_hash  TEXT,
        updates       INTEGER NOT NULL DEFAULT 0,
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (source_id, element_kind, element_key)
      );
`;

export const v207: Migration = {
  version: 207,
  name: 'retrieval_feedback',
  idempotent: true,
  sql: RETRIEVAL_FEEDBACK_SQL,
};
