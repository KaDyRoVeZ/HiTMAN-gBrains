/**
 * Real-Postgres proof for group spend budgets and the spend fence.
 *
 * PGLite serializes one connection, so it cannot show that the per-key
 * advisory lock stops concurrent children from jointly passing a group cap,
 * or how the protocol trigger treats an un-upgraded worker's claim SQL.
 *
 * Run:
 *   DATABASE_URL=postgresql://... bun test test/e2e/budget-meter-group.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUIDv7 } from 'bun';
import { PostgresEngine } from 'gbrain';
import { GroupBudgetRefusal, clientLockKey, readGroupSpend, reserveGroup, settle } from '../../src/core/minions/budget-meter.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { jobSpendAuthorization } from '../../src/core/minions/spend-authorization.ts';
import { queryAgentClientSpend } from '../../src/commands/serve-http-admin-api.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('group spend budget — Postgres', () => {
  let engine: PostgresEngine;
  let key = '';

  beforeAll(async () => {
    engine = new PostgresEngine();
    assertSafeE2eDatabaseUrl(databaseUrl!);
    await engine.connect({ database_url: databaseUrl!, poolSize: 16 });
    await engine.initSchema();
  });

  beforeEach(() => { key = `group:${randomUUIDv7()}`; });

  afterAll(async () => {
    await engine.executeRaw(`DELETE FROM mcp_spend_reservations WHERE budget_key LIKE 'group:%'`);
    await engine.executeRaw(`DELETE FROM mcp_spend_log WHERE budget_key LIKE 'group:%'`);
    await engine.executeRaw(`DELETE FROM oauth_clients WHERE client_id LIKE 'group-e2e-%'`);
    await engine.executeRaw(`DELETE FROM minion_jobs WHERE data->>'e2e' = 'budget-meter-group'`);
    await engine?.disconnect();
  });

  const hold = (estimatedCents: number, capCents = 100) =>
    reserveGroup(engine, { budgetKey: key, estimatedCents, capCents, model: 'test-provider:test-model', provider: 'test-provider' });

  test('concurrent children cannot jointly reserve past the group cap', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 20 }, () => hold(10)));
    const admitted = attempts.filter(a => a.status === 'fulfilled');
    expect(admitted).toHaveLength(10);
    for (const a of attempts) if (a.status === 'rejected') expect(a.reason).toBeInstanceOf(GroupBudgetRefusal);
    expect((await readGroupSpend(engine, key)).liveCents).toBe(100);
  });

  for (const order of ['sibling commits its hold first', 'sibling commits nothing'] as const) {
    test(`a reservation waits on the group lock while a sibling holds it (${order})`, async () => {
      let unlock!: () => void;
      const locked = new Promise<void>(r => { unlock = r; });
      let lockHeld!: () => void;
      const held = new Promise<void>(r => { lockHeld = r; });
      const sibling = engine.transaction(async (tx) => {
        await tx.executeRaw('SELECT pg_advisory_xact_lock($1)', [clientLockKey(key)]);
        lockHeld();
        await locked;
        if (order === 'sibling commits its hold first') {
          await tx.executeRaw(
            `INSERT INTO mcp_spend_reservations (reservation_id, budget_key, estimated_cents, model, provider, status, expires_at)
             VALUES ($1, $2, 80, 'm', 'p', 'pending', now() + interval '10 minutes')`, [randomUUIDv7(), key]);
        }
      });
      await held;
      const contender = hold(80).then(r => ({ ok: r }), e => ({ err: e }));
      await new Promise(r => setTimeout(r, 200));
      unlock();
      await sibling;
      const outcome = await contender;
      if (order === 'sibling commits its hold first') {
        expect((outcome as { err: GroupBudgetRefusal }).err.kind).toBe('pressure');
      } else {
        expect((outcome as { ok: unknown }).ok).toBeDefined();
      }
    });
  }

  test('an overdue hold stays charged until reconciled', async () => {
    await hold(100);
    await engine.executeRaw(`UPDATE mcp_spend_reservations SET expires_at = now() - interval '1 second' WHERE budget_key = $1`, [key]);
    const refused = await hold(1).catch(e => e);
    expect((refused as GroupBudgetRefusal).kind).toBe('exhausted');
  });

  test('admin client spend excludes group rows', async () => {
    const clientId = `group-e2e-${randomUUIDv7()}`;
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, client_secret_hash, scope, grant_types, redirect_uris, token_endpoint_auth_method, bound_tools, created_at)
       VALUES ($1, $1, '', 'read', ARRAY['client_credentials'], ARRAY[]::text[], 'client_secret_post', ARRAY['search'], now())`, [clientId]);
    const r = await hold(50);
    await settle(engine, r.reservationId, 50);
    const row = (await queryAgentClientSpend(engine)).find(c => c.client_id === clientId)!;
    expect(row).toMatchObject({ spent_cents_today: 0, pending_cents: 0 });
  });

  test('a reservation or log row with both budget owners is refused', async () => {
    await expect(engine.executeRaw(
      `INSERT INTO mcp_spend_reservations (reservation_id, client_id, budget_key, estimated_cents, model, provider, status, expires_at)
       VALUES ($1, 'group-e2e-x', $2, 1, 'm', 'p', 'pending', now())`, [randomUUIDv7(), key])).rejects.toThrow();
    await expect(engine.executeRaw(
      `INSERT INTO mcp_spend_log (client_id, budget_key, operation, spend_cents) VALUES ('group-e2e-x', $1, 'op', 1)`, [key])).rejects.toThrow();
  });
});

describePostgres('spend fence — Postgres', () => {
  let engine: PostgresEngine;
  let queue: MinionQueue;
  const queueName = `spend-fence-${randomUUIDv7()}`;

  beforeAll(async () => {
    engine = new PostgresEngine();
    assertSafeE2eDatabaseUrl(databaseUrl!);
    await engine.connect({ database_url: databaseUrl!, poolSize: 4 });
    await engine.initSchema();
    queue = new MinionQueue(engine);
  });

  afterAll(async () => {
    await engine.executeRaw(`DELETE FROM minion_jobs WHERE queue = $1`, [queueName]);
    await engine?.disconnect();
  });

  /** The claim SQL of a worker from before the spend fence: no spend_claim_token. */
  const oldWorkerClaim = () => engine.executeRaw<{ id: number }>(
    `UPDATE minion_jobs SET status = 'active', claim_generation = claim_generation + 1, lock_token = 'old-worker',
            attempts_started = attempts_started + 1, started_at = COALESCE(started_at, now()), updated_at = now()
      WHERE id = (SELECT id FROM minion_jobs WHERE queue = $1 AND status = 'waiting' AND submission_authority IS NOT NULL
                   ORDER BY priority ASC, created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id`, [queueName]);

  test('an old worker stalls at a fenced row ahead of a NULL row; an upgraded worker claims both', async () => {
    const spend = jobSpendAuthorization({ consented_effects: ['paid'], cap_usd: 5, cap_source: 'user', via: 'max_usd' }, { command: 'book-mirror', of: 1 });
    const fenced = await queue.add('subagent', { e2e: 'budget-meter-group', prompt: 'a' }, { queue: queueName }, { allowProtectedSubmit: true, spendAuthorization: spend });
    const open = await queue.add('subagent', { e2e: 'budget-meter-group', prompt: 'b' }, { queue: queueName }, { allowProtectedSubmit: true });
    await expect(oldWorkerClaim()).rejects.toThrow('Minion spend protocol 1 required');
    expect((await queue.getJob(open.id))!.status).toBe('waiting');
    const first = await queue.claim('new-worker-1', 60_000, queueName, ['subagent']);
    const second = await queue.claim('new-worker-2', 60_000, queueName, ['subagent']);
    expect([first?.id, second?.id]).toEqual([fenced.id, open.id]);
  });

  test('new-worker claim, stall, then an old-worker reclaim is refused', async () => {
    const spend = jobSpendAuthorization({ consented_effects: ['paid'], cap_usd: 5, cap_source: 'user', via: 'max_usd' }, { command: 'enrich', of: 1 });
    const job = await queue.add('enrich', { e2e: 'budget-meter-group', sourceId: 'default' }, { queue: queueName }, { spendAuthorization: spend });
    expect((await queue.claim('new-worker', 60_000, queueName, ['enrich']))?.id).toBe(job.id);
    await engine.executeRaw(`UPDATE minion_jobs SET status = 'waiting', lock_token = NULL, lock_until = NULL WHERE id = $1`, [job.id]);
    await expect(oldWorkerClaim()).rejects.toThrow('Minion spend protocol 1 required');
  });
});
