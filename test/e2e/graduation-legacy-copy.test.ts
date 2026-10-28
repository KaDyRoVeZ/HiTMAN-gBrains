/**
 * The independent legacy fixture through the real drain, copier and digest,
 * checked against expected.json by a checker that shares no code with them.
 *
 * Protects: the copy layer's handling of every hand-built legacy state
 * (unattributed rows kept unattributed, the withdrawal overlay, take and fact
 * supersession, byte-heavy jsonb, vectors as text, collation-sensitive text
 * keys) and its permitted transforms (stale lease -> waiting, orphan running
 * effect -> queued, worktree heartbeat reset, cycle locks discarded, queued
 * request drained), under both trigger-bypass mechanisms. Custody is not
 * involved, so `persistence_brain.enabled` stays false on the target and that
 * one expectation is asserted as such here; the crash and CLI suites cover
 * the cutover.
 * Regressions it catches: a transform the inventory applies that the plan
 * does not allow (or the reverse); graduation-digest and the independent
 * checker disagreeing about the same copy.
 * Not covered elsewhere: the copier's own E2E (graduation-copy.test.ts) uses
 * only the generated history fixture.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import type { GBrainConfig } from '../../src/core/config.ts';
import { configureGateway } from '../../src/core/ai/gateway.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { buildDeferredIndexes, copySequences, deferIndexes } from '../../src/core/persistence/graduation-copy.ts';
import { drainForGraduation, freezeSource } from '../../src/core/persistence/graduation-drain.ts';
import { embeddingLayoutMismatches, embeddingColumns, sourceEmbeddingLayout } from '../../src/core/persistence/graduation-target.ts';
import { legacyTargetMismatches, snapshotLegacySource } from '../fixtures/graduation/legacy-brain.ts';
import { copiedEntries, copyAll, digestMismatches } from '../helpers/graduation-copy-harness.ts';
import { DATABASE_URL } from '../helpers/graduation-e2e.ts';
import { legacyCase, scratchRoot, withSource } from '../helpers/graduation-scenarios.ts';
import { LEGACY_EMBEDDING_CONFIG } from '../helpers/legacy-embedding-config.ts';

const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  for (const close of closers.reverse()) await close().catch(() => {});
  rmSync(scratchRoot, { recursive: true, force: true });
});

describe.skipIf(!DATABASE_URL)('graduation copy layer on the legacy fixture', () => {
  for (const bypass of ['session_replication_role', 'disable_trigger'] as const) {
    test(`${bypass}: drained, copied and digested; every expected.json target expectation holds`, async () => {
      const c = await legacyCase(`legacy-copy-${bypass}`);
      closers.push(() => c.target.close());
      const result = await withSource(c.fx, async source => {
        const drained = await drainForGraduation(source, { timeoutMs: 60_000, hostId: localHostId(), config: { engine: 'pglite', embedding_disabled: true } as GBrainConfig });
        expect(drained.blockers).toEqual([]);
        expect(drained.drained).toContain('00000000-0000-4000-8000-0000000000a1');
        await freezeSource(source);
        const before = await snapshotLegacySource(source);
        // The orchestrator sizes the target from the source layout; do the same before initSchema.
        const layout = await sourceEmbeddingLayout(source);
        configureGateway({ embedding_model: layout.config.embedding_model, embedding_dimensions: Number(layout.config.embedding_dimensions), env: {} });
        const target = new PostgresEngine();
        await target.connect({ database_url: c.target.url, poolSize: 4 });
        try {
          await target.initSchema();
          expect(embeddingLayoutMismatches(layout.columns, await embeddingColumns((sql, p) => target.executeRaw(sql, p)))).toEqual([]);
          const e = { source, target };
          const entries = [...await copiedEntries(e)];
          const runId = randomUUID();
          await deferIndexes(target, { runId });
          await copyAll(e, entries, { bypass, runId, batchBytes: 256 * 1024 });
          await copySequences(e, { runId });
          await buildDeferredIndexes(target, { runId, log: () => {} });
          const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(target) });
          return { digests: await digestMismatches(e, entries), mismatches: await legacyTargetMismatches(target, before, token => provider.verifyAccessToken(token)) };
        } finally { await target.disconnect(); }
      });
      expect(result.digests).toEqual([]);
      expect(result.mismatches).toEqual([
        'target brain: expected {"enabled":true,"brain_id_equals_source":true}, got {"enabled":false,"brain_id_equals_source":true}',
      ]);
    }, 600_000);
  }
});
