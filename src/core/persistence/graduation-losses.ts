/**
 * Engine graduation rollback write detection: after cutover, compare the
 * target with the graduation receipt per carried table (reported by loss
 * kind) and compare its security state with the retained PGLite copy by
 * identity and content (revocations delete rows, so timestamps cannot show
 * them). Withdrawals and security changes are final; nothing is ever written
 * back to the source.
 */
import type { BrainEngine } from '../engine.ts';
import type { Inventory, LossKind, TableReceipt } from './engine-graduation.types.ts';
import type { digestTable } from './graduation-digest.ts';

/** Usage-tracking columns that change on every authorized call; not a security change. */
const SECURITY_VOLATILE_COLUMNS = new Set(['last_used_at']);
const SECURITY_TABLES = ['access_tokens', 'oauth_clients', 'oauth_tokens', 'oauth_grant_audit', 'persistence_local_writers', 'fact_withdrawals'] as const;

export interface RollbackLoss {
  relation: string;
  lossKind: LossKind;
  change: 'changed' | 'added' | 'missing' | 'requests_after_cutover';
  rows: number;
  /** Withdrawals and security changes are never confirmable (nothing is written back to the source). */
  final: boolean;
}

export async function rollbackLosses(input: {
  target: BrainEngine;
  inventory: Inventory;
  /** The verified target receipts recorded on the target row. */
  receipts: readonly TableReceipt[];
  cutoverSequence: string;
  digestTable: typeof digestTable;
  /** Opens the retained PGLite copy read-only, or null when it is gone. */
  openRetained: (() => Promise<BrainEngine>) | null;
}): Promise<RollbackLoss[]> {
  const losses: RollbackLoss[] = [];
  const receipts = new Map(input.receipts.map(r => [r.relation, r]));
  const securityNames = new Set<string>(SECURITY_TABLES);
  for (const entry of input.inventory.entries) {
    if (!(entry.class === 'carry' || entry.class === 'rebind') || !entry.engines.postgres || securityNames.has(entry.relation)) continue;
    const before = receipts.get(entry.relation);
    if (!before) continue;
    // persistence_brain.enabled legitimately differs after cutover: digest it through its transform, like the receipt.
    const now = await input.digestTable(input.target, entry, { applyTransforms: entry.relation === 'persistence_brain' });
    if (now.rootSha256 !== before.rootSha256) {
      losses.push({ relation: entry.relation, lossKind: entry.lossKind, change: 'changed', rows: Math.abs(now.rows - before.rows) || now.rows, final: false });
    }
  }
  const [after] = await input.target.executeRaw<{ n: string }>('SELECT count(*)::text AS n FROM persistence_requests WHERE sequence > $1::bigint', [input.cutoverSequence]);
  if (Number(after?.n ?? 0) > 0) losses.push({ relation: 'persistence_requests', lossKind: 'user_data', change: 'requests_after_cutover', rows: Number(after!.n), final: false });
  losses.push(...await compareSecurityState(input.target, input.openRetained));
  return losses;
}

async function primaryKey(engine: BrainEngine, relation: string): Promise<string[]> {
  const rows = await engine.executeRaw<{ attname: string }>(
    `SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = to_regclass($1) AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)`, [relation]);
  return rows.map(r => r.attname);
}

async function securityRows(engine: BrainEngine, relation: string): Promise<Map<string, { content: string; row: Record<string, unknown> }> | null> {
  const [present] = await engine.executeRaw<{ q: string | null }>(`SELECT CASE WHEN to_regclass($1) IS NULL THEN NULL ELSE quote_ident($1) END AS q`, [relation]);
  if (!present?.q) return null;
  const pk = await primaryKey(engine, relation);
  const rows = await engine.transaction(async tx => {
    await tx.executeRaw(`SELECT set_config('TimeZone', 'UTC', true)`);
    return tx.executeRaw<{ r: unknown }>(`SELECT to_jsonb(t) AS r FROM ${present.q} t`);
  });
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value as object).sort().map(k => [k, canonical((value as Record<string, unknown>)[k])])) : value;
  const out = new Map<string, { content: string; row: Record<string, unknown> }>();
  for (const { r } of rows) {
    const row = (typeof r === 'string' ? JSON.parse(r) : r) as Record<string, unknown>;
    const key = JSON.stringify(pk.map(c => row[c]));
    const content = JSON.stringify(canonical(Object.fromEntries(Object.entries(row).filter(([k]) => !SECURITY_VOLATILE_COLUMNS.has(k)))));
    out.set(key, { content, row });
  }
  return out;
}

/** Security state by identity and content against the retained source (revocations delete rows; timestamps cannot show them). */
async function compareSecurityState(target: BrainEngine, openRetained: (() => Promise<BrainEngine>) | null): Promise<RollbackLoss[]> {
  if (!openRetained) return [];
  const retained = await openRetained();
  const losses: RollbackLoss[] = [];
  try {
    const nowSeconds = Math.floor(Date.now() / 1000);
    for (const relation of SECURITY_TABLES) {
      const [source, onTarget] = [await securityRows(retained, relation), await securityRows(target, relation)];
      if (!source || !onTarget) continue;
      let missing = 0, changed = 0, added = 0;
      for (const [key, value] of source) {
        const other = onTarget.get(key);
        if (!other) {
          const expires = Number(value.row.expires_at);
          if (relation === 'oauth_tokens' && Number.isFinite(expires) && expires > 0 && expires < nowSeconds) continue;
          missing += 1;
        } else if (other.content !== value.content) changed += 1;
      }
      for (const key of onTarget.keys()) if (!source.has(key)) added += 1;
      const withdrawal = relation === 'fact_withdrawals';
      if (missing) losses.push({ relation, lossKind: withdrawal ? 'user_data' : 'security', change: 'missing', rows: missing, final: true });
      if (changed) losses.push({ relation, lossKind: withdrawal ? 'user_data' : 'security', change: 'changed', rows: changed, final: true });
      if (added) losses.push({ relation, lossKind: withdrawal ? 'user_data' : 'security', change: 'added', rows: added, final: withdrawal });
    }
  } finally { await retained.disconnect(); }
  return losses;
}
