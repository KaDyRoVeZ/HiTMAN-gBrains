import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #5876: the Life Chronicle ledger. One row per (source, page, content,
// extractor version) records the write-time decision and the extraction
// outcome; it, not minion idempotency keys (pruned with their jobs), is the
// record of what was extracted. chronicle_judge_reservations holds one row
// per automatic judge call for the rolling daily limit. The activation stamp
// (config chronicle.activated_at) is stamped by the first write decision or chronicle phase run.
export const v199: Migration = {
  version: 199,
  name: 'chronicle_page_state',
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS chronicle_page_state (
        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
        content_hash TEXT NOT NULL,
        extractor_version INTEGER NOT NULL,
        slug TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','skipped','extracted','failed')),
        reason TEXT,
        trigger TEXT NOT NULL CHECK (trigger IN ('auto','backfill')),
        principal_kind TEXT,
        principal_id TEXT,
        request_id UUID,
        no_extract BOOLEAN NOT NULL DEFAULT false,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TIMESTAMPTZ,
        cost_usd NUMERIC,
        unpriced BOOLEAN NOT NULL DEFAULT false,
        event_slugs TEXT[] NOT NULL DEFAULT '{}',
        event_hashes TEXT[] NOT NULL DEFAULT '{}',
        decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (source_id, page_id, content_hash, extractor_version)
      );
      CREATE INDEX IF NOT EXISTS chronicle_page_state_work_idx
        ON chronicle_page_state (source_id, state, next_attempt_at);
      CREATE INDEX IF NOT EXISTS chronicle_page_state_page_idx ON chronicle_page_state (page_id);
      CREATE TABLE IF NOT EXISTS chronicle_judge_reservations (
        id BIGSERIAL PRIMARY KEY,
        reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        source_id TEXT NOT NULL,
        page_id INTEGER NOT NULL,
        content_hash TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chronicle_judge_reservations_at_idx ON chronicle_judge_reservations (reserved_at);
      DO $rls$ BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND rolbypassrls) THEN
          ALTER TABLE chronicle_page_state ENABLE ROW LEVEL SECURITY;
          ALTER TABLE chronicle_judge_reservations ENABLE ROW LEVEL SECURITY;
        END IF;
      END $rls$;
    `,
};
