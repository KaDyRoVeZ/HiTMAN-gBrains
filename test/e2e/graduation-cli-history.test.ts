/**
 * Engine graduation of the 1k-page history fixture: verify green, every
 * history table and row identical on the target, the queued request committed
 * and the delayed effect still queued, with the plan-to-green-doctor clock
 * under five minutes. Split from graduation-cli.test.ts
 * (test/helpers/graduation-cli-cases.ts).
 */
import { describe, expect } from 'bun:test';
import { HISTORY_FIXTURE_TABLES } from '../../scripts/persistence/history-fixture.ts';
import { custodyPaths, DATABASE_URL, gbrain, graduationTest, planHashOf, TARGET_ENV } from '../helpers/graduation-e2e.ts';
import { useGraduationCases } from '../helpers/graduation-cli-cases.ts';
import { doctorFailures, historyCase, withSource, withTarget } from '../helpers/graduation-scenarios.ts';
import { canonicalRows } from '../fixtures/graduation/legacy-brain.ts';

const { cleanups } = useGraduationCases();

describe.skipIf(!DATABASE_URL)('graduation: 1k-page history round trip', () => {
  graduationTest('1,000 pages with history graduate with verify green and the plan-to-green-doctor clock under five minutes', async () => {
    const { fx, target } = await historyCase('history-1k', 1000);
    cleanups.push(() => target.close());
    const env = { [TARGET_ENV]: target.url };
    const t0 = Date.now();
    const plan = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--json'], { home: fx.home, env });
    expect(plan.code).toBe(3);
    const run = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--yes', '--expect', String(planHashOf(plan.json)), '--json'],
      { home: fx.home, env, timeoutMs: 1_800_000 });
    expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    const doctor = await doctorFailures(fx.home);
    const wallMs = Date.now() - t0;
    expect(doctor.failing).toEqual([]);
    console.log(JSON.stringify({ graduation_1k: { wall_ms: wallMs, fixture: fx.report, timings: run.json?.receipt?.timings ?? run.json?.timings ?? null } }));
    expect(wallMs).toBeLessThan(5 * 60_000);

    const retained = custodyPaths(fx.dataDir).graduated[0];
    const outputs = fx.outputs as { queuedRequestId: string; delayedEffectId: string };
    const sourceSide = await withSource(fx, async source => {
      const counts: Record<string, number> = {};
      for (const table of HISTORY_FIXTURE_TABLES) counts[table] = Number((await source.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0].n);
      const rows: Record<string, string[]> = {};
      for (const table of ['pages', 'page_versions', 'facts', 'takes', 'fact_withdrawals', 'content_chunks', 'access_tokens', 'oauth_clients', 'oauth_tokens']) rows[table] = await canonicalRows(source, table);
      return { counts, rows };
    }, retained);
    await withTarget(target.url, async t => {
      for (const table of HISTORY_FIXTURE_TABLES) {
        const n = Number((await t.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0].n);
        expect({ table, n }).toEqual({ table, n: sourceSide.counts[table] });
      }
      for (const [table, rows] of Object.entries(sourceSide.rows)) {
        const got = await canonicalRows(t, table);
        const first = got.findIndex((row, i) => row !== rows[i]);
        expect({ table, length: got.length, first }).toEqual({ table, length: rows.length, first: -1 });
      }
      const [queued] = await t.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [outputs.queuedRequestId]);
      expect(queued.state).toBe('committed');
      const [delayed] = await t.executeRaw<{ state: string }>('SELECT state FROM persistence_effects WHERE id=$1', [outputs.delayedEffectId]);
      expect(delayed.state).toBe('queued');
    });
  }, 1_800_000);
});
