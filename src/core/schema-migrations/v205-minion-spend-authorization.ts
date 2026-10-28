import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Submit-time spend authorization on queued paid jobs
// (src/core/minions/spend-authorization.ts). `spend_authorization` holds the
// consent record a trusted producer stored; `spend_claim_token` is the
// per-acquisition fence: a claim of a spend-authorized row must set it to the
// new claim_generation, which only spend-aware workers do. The meter tables
// gain `budget_key` so a command group shares one lifetime total; each
// reservation names exactly one budget owner (an OAuth client or a group).
// No backfill: workers stamp legacy rows at claim time.
const MINION_QUEUE_PROTOCOL_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION enforce_minion_queue_protocol() RETURNS trigger SET search_path = pg_catalog, public AS $protocol$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.submission_authority IS NULL OR NEW.claim_generation <> 0 THEN
      RAISE EXCEPTION 'Minion queue protocol 1 required: upgrade every producer and worker before restart';
    END IF;
  ELSIF NEW.status = 'active' AND (OLD.status <> 'active' OR NEW.lock_token IS DISTINCT FROM OLD.lock_token) THEN
    IF NEW.submission_authority IS NULL OR NEW.claim_generation IS DISTINCT FROM OLD.claim_generation + 1 THEN
      RAISE EXCEPTION 'Minion queue protocol 1 required: old workers cannot claim upgraded queue jobs';
    END IF;
    IF NEW.spend_authorization IS NOT NULL AND NEW.spend_claim_token IS DISTINCT FROM NEW.claim_generation THEN
      RAISE EXCEPTION 'Minion spend protocol 1 required: only upgraded workers can claim spend-authorized jobs; restart workers on the upgraded binary';
    END IF;
  ELSIF NEW.claim_generation IS DISTINCT FROM OLD.claim_generation THEN
    RAISE EXCEPTION 'Minion queue claim generation may advance only with a claim';
  END IF;
  RETURN NEW;
END;
$protocol$ LANGUAGE plpgsql;`;

export const v205: Migration = {
  version: 205,
  name: 'minion_spend_authorization',
  idempotent: true,
  sql: `
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS spend_authorization JSONB;
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS spend_claim_token BIGINT;
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_spend_group
        ON minion_jobs ((spend_authorization->>'group_id')) WHERE spend_authorization IS NOT NULL;
      ALTER TABLE mcp_spend_reservations ADD COLUMN IF NOT EXISTS budget_key TEXT;
      ALTER TABLE mcp_spend_reservations ALTER COLUMN client_id DROP NOT NULL;
      ALTER TABLE mcp_spend_reservations DROP CONSTRAINT IF EXISTS mcp_spend_reservations_one_budget_owner;
      ALTER TABLE mcp_spend_reservations ADD CONSTRAINT mcp_spend_reservations_one_budget_owner
        CHECK ((client_id IS NULL) <> (budget_key IS NULL));
      CREATE INDEX IF NOT EXISTS idx_mcp_spend_reservations_budget_key
        ON mcp_spend_reservations (budget_key) WHERE budget_key IS NOT NULL;
      ALTER TABLE mcp_spend_log ADD COLUMN IF NOT EXISTS budget_key TEXT;
      ALTER TABLE mcp_spend_log DROP CONSTRAINT IF EXISTS mcp_spend_log_one_budget_owner;
      ALTER TABLE mcp_spend_log ADD CONSTRAINT mcp_spend_log_one_budget_owner
        CHECK (client_id IS NULL OR budget_key IS NULL);
      CREATE INDEX IF NOT EXISTS idx_mcp_spend_log_budget_key
        ON mcp_spend_log (budget_key) WHERE budget_key IS NOT NULL;
${MINION_QUEUE_PROTOCOL_FUNCTION_SQL}
    `,
};
