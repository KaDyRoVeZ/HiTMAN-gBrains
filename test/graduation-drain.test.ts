/**
 * Engine graduation drain (`src/core/persistence/graduation-drain.ts`) and the
 * consumer's request-only mode (`requestsOnly` in `consumer.ts`).
 *
 * Protects: the pending request of a `buildHistoryFixture` brain drains to a
 * terminal state through a request-only consumer that runs no effects (the
 * drained request's effects stay queued for the target's worker), no resident
 * service is left running, the blocker taxonomy (queued request drained;
 * foreign host binding, writer admin lock, recovering effect and (PGLite) an
 * OAuth client bound to a missing source refuse up
 * front with their structured actions and the drain starts nothing), the
 * `--drain-timeout` refusal shape, and the frozen source (writes fail,
 * custody writes through `withSourceWritable` succeed).
 * Fails when: the drain runs effect work, leaves a publication in flight,
 * cancels or skips a request, or a frozen source accepts a background write.
 * Seams: none; PGLite always, Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GBrainConfig } from '../src/core/config.ts';
import { buildHistoryFixture } from '../scripts/persistence/history-fixture.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { persistenceConsumerStatus } from '../src/core/persistence/service.ts';
import { WRITER_ADMIN_LOCK_KEY } from '../src/core/persistence/admin-contract.ts';
import { drainForGraduation, freezeSource, graduationBlockers, unfreezeSource, withSourceWritable } from '../src/core/persistence/graduation-drain.ts';
import { drainTimeoutError } from '../src/core/persistence/graduation-errors.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const config = (engine: string) => ({ engine, embedding_disabled: true }) as GBrainConfig;

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test(`${backend}: request-only drain of a history brain, blockers, and the frozen source`, async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-graduation-drain-test-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          const fixture = await buildHistoryFixture(engine, { pages: 12, seed: 5, sources: 2, worktrees: 1, root: join(home, 'checkouts') });
          const hostId = localHostId();
          const before = await graduationBlockers(engine, hostId);
          expect(before).toEqual([expect.objectContaining({ kind: 'request', id: fixture.queuedRequestId, needsUser: false })]);
          expect(before[0]!.argv).toBeUndefined();
          const delayedBefore = await engine.executeRaw('SELECT state, attempts, next_attempt_at::text AS at FROM persistence_effects WHERE id = $1', [fixture.delayedEffectId]);

          const result = await drainForGraduation(engine, { timeoutMs: 30_000, hostId, config: config(engine.kind), pollMs: 50 });
          expect(result).toEqual({ drained: [fixture.queuedRequestId], blockers: [] });
          const [request] = await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id = $1::uuid', [fixture.queuedRequestId]);
          expect(request!.state).toBe('committed');
          const effects = await engine.executeRaw<{ state: string }>(`SELECT e.state FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id
            WHERE r.request_id = $1::uuid`, [fixture.queuedRequestId]);
          expect(effects.length).toBeGreaterThan(0);
          expect(effects.every(e => e.state === 'queued')).toBe(true);
          expect(await engine.executeRaw('SELECT state, attempts, next_attempt_at::text AS at FROM persistence_effects WHERE id = $1', [fixture.delayedEffectId])).toEqual(delayedBefore);
          expect(persistenceConsumerStatus(engine).state).toBe('not_running');
          expect(await drainForGraduation(engine, { timeoutMs: 1000, hostId, config: config(engine.kind) })).toEqual({ drained: [], blockers: [] });

          const [worktree] = await engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM persistence_worktrees LIMIT 1');
          const foreignHost = randomUUID();
          await engine.transaction(async tx => {
            await tx.executeRaw('SET LOCAL session_replication_role = replica');
            await tx.executeRaw(`INSERT INTO persistence_host_bindings (worktree_id, host_id, local_path, coordination_path) VALUES ($1::uuid, $2::uuid, '/elsewhere', '/elsewhere/.coord')`,
              [worktree!.id, foreignHost]);
            await tx.executeRaw(`INSERT INTO config (key, value) VALUES ($1, '{"locked": true, "set_at": "2026-10-04T00:00:00Z"}')
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [WRITER_ADMIN_LOCK_KEY]);
            await tx.executeRaw(`UPDATE persistence_effects SET recovery = '{"kind": "test"}'::jsonb WHERE id = $1`, [fixture.delayedEffectId]);
            if (engine.kind === 'pglite') await tx.executeRaw("UPDATE oauth_clients SET bound_source_id = 'removed-source' WHERE client_id = $1", [fixture.oauthClientId]);
          });
          const blocked = await drainForGraduation(engine, { timeoutMs: 1000, hostId, config: config(engine.kind) });
          expect(blocked.drained).toEqual([]);
          expect(blocked.blockers).toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'writer_admin_lock', argv: ['gbrain', 'sources', 'writer', 'unlock'], needsUser: true }),
            expect.objectContaining({ kind: 'foreign_host_binding', id: `${worktree!.id}:${foreignHost}`, needsUser: true,
              argv: expect.arrayContaining(['gbrain', 'sources', 'writer', 'transfer', 'prepare']) }),
            expect.objectContaining({ kind: 'effect_recovery', id: String(fixture.delayedEffectId), needsUser: false }),
          ]));
          if (engine.kind === 'pglite') {
            expect(blocked.blockers).toContainEqual(expect.objectContaining({ kind: 'dangling_reference', id: `oauth_clients.${fixture.oauthClientId}`,
              argv: ['gbrain', 'auth', 'revoke-client', fixture.oauthClientId], needsUser: true }));
          }

          if (engine.kind === 'pglite') {
            await freezeSource(engine);
            await expect(engine.executeRaw("UPDATE config SET value = value WHERE key = 'version'")).rejects.toThrow(/read-only transaction/);
            expect(await engine.executeRaw("SELECT 1 FROM config WHERE key = 'version'")).toHaveLength(1);
            await withSourceWritable(engine, tx => tx.executeRaw("INSERT INTO config (key, value) VALUES ('graduation.test', 'custody')"));
            expect(await engine.executeRaw("SELECT value FROM config WHERE key = 'graduation.test'")).toEqual([{ value: 'custody' }]);
            await expect(engine.executeRaw("DELETE FROM config WHERE key = 'graduation.test'")).rejects.toThrow(/read-only transaction/);
            await unfreezeSource(engine);
            await engine.executeRaw("DELETE FROM config WHERE key = 'graduation.test'");
          } else {
            await expect(freezeSource(engine)).rejects.toThrow(/PGLite source/);
          }
        } finally { await close(); }
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  }, 300_000);
}

describe('drainTimeoutError', () => {
  test('progressing requests resume with twice the timeout', () => {
    const json = drainTimeoutError({ blockers: [{ kind: 'request', id: 'r1', detail: 'put_page running (source a)', needsUser: false }], timeoutSec: 60 }).toJSON() as Record<string, any>;
    expect(json.code).toBe('graduation_drain_timeout');
    expect(json.fix.argv).toEqual(['gbrain', 'migrate', '--resume', '--drain-timeout', '120']);
    expect(json.reason).toBe('progressing');
    expect(json.fix.verify.argv).toEqual(['gbrain', 'migrate', '--status', '--json']);
    expect(json.why).toContain('source is unchanged and writable');
  });

  test('a blocker with its own action is named instead of a longer wait', () => {
    const json = drainTimeoutError({ blockers: [
      { kind: 'request', id: 'r1', detail: 'running', needsUser: false },
      { kind: 'request', id: 'r2', detail: 'recovering', argv: ['gbrain', 'sync', '--source', 'a', '--no-pull', '--retry-failed'], needsUser: false },
    ], timeoutSec: 5 }).toJSON() as Record<string, any>;
    expect(json.fix.argv).toEqual(['gbrain', 'sync', '--source', 'a', '--no-pull', '--retry-failed']);
    expect(json.fix.actor).toBe('agent');
  });
});
