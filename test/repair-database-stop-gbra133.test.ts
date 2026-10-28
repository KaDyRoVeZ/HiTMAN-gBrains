/**
 * GBRA-133: a repair apply that the database refuses mid-run (a deadlock, a serialization failure, a lost connection) stops
 * with a result: what it applied, the stop reason with the SQLSTATE, and the resume command; the cursor stays before the
 * refused item, so the same command resumes there. Before, the error ended the command and an `--apply --json` run left
 * no record of what it had applied. The CLI's apply opts in (`recordDatabaseStops`); the cycle and doctor remediation keep
 * the rethrow, which their own run-scoped stops rely on (pinned by the default case below). A termination signal (the CLI's SIGTERM or SIGHUP) stops the apply the same way before
 * its next item. Real PGLite (and Postgres when DATABASE_URL is set) for the cursor; a stub kind.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { afterCursor, resolveRepairScope, runRepair, type RepairHandler, type RepairItem, type RepairKind } from '../src/core/repair/core.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const quiet = { info() {}, warn() {}, error() {} };

for (const backend of testBackends()) describe(`[${backend}] GBRA-133: a database refusal stops a repair apply with a result`, () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (backend === 'pglite') { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
    else { const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase()); engine = pg.engine; close = pg.close; }
  }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); if (close) await close(); else await engine.disconnect(); });

  const items: RepairItem[] = [1, 2, 3].map(id => ({ cursor: { phase: 0, id }, source_id: 'default', slug: `notes/p${id}`, chars: 0, action: 'stub' }));
  function stub(failing: Map<number, unknown>) {
    const applied: number[] = [];
    const handler: RepairHandler = {
      kind: 'gbra133-stub' as RepairKind,
      async plan(_engine, _scope, after) { return { items: items.filter(item => afterCursor(item.cursor, after)), residuals: {}, preview_hash: 'stub-hash' }; },
      async apply(_ctx, item) {
        const error = failing.get(item.cursor.id);
        if (error) { failing.delete(item.cursor.id); throw error; }
        applied.push(item.cursor.id);
        return { applied: true, outcome: 'repaired' };
      },
    };
    return { handler, applied };
  }
  const ctx = () => ({ engine, sourceId: 'default', remote: false, config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: quiet }) as never;

  for (const [name, error, reason] of [
    ['a deadlock (40P01)', Object.assign(new Error('deadlock detected'), { code: '40P01' }), 'database_contention'],
    ['a serialization failure (40001)', Object.assign(new Error('could not serialize access due to concurrent update'), { code: '40001' }), 'database_contention'],
    ['a lost connection', Object.assign(new Error('Connection terminated unexpectedly'), { code: 'CONNECTION_CLOSED' }), 'connection_lost'],
  ] as const) test(`${name}: the run stops with what it applied and resumes at the refused item`, async () => {
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='repair'");
    const { handler, applied } = stub(new Map([[2, error]]));
    const scope = await resolveRepairScope(engine);
    const first = await runRepair(ctx(), handler, scope, { apply: true, expect: 'stub-hash', explicit: true, recordDatabaseStops: true });
    expect(applied).toEqual([1]);
    expect(first.applied).toBe(1);
    expect(first.complete).toBe(false);
    expect(first.stopped).toMatchObject({ reason });
    expect(first.stopped!.message).toStartWith('Stopped at default:notes/p2: the database refused this item');
    if (error.code !== 'CONNECTION_CLOSED') expect(first.stopped!.message).toContain(`(${error.code})`);
    expect(first.stopped!.message).toContain(`Rerun \`${first.apply_command}\` to resume from this item.`);
    expect(first.stopped!.fix?.argv).toEqual(['gbrain', 'repair', 'gbra133-stub', '--json']);
    const second = await runRepair(ctx(), handler, scope, { apply: true, expect: 'stub-hash', explicit: true, recordDatabaseStops: true });
    expect(applied).toEqual([1, 2, 3]);
    expect(second).toMatchObject({ applied: 2, complete: true, resumed_from: { phase: 0, id: 1 } });
    expect(second.stopped).toBeUndefined();
  }, 60_000);

  test('without the CLI opt-in a run-scoped database error still rethrows (cycle and remediation callers)', async () => {
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='repair'");
    const { handler } = stub(new Map([[2, Object.assign(new Error('deadlock detected'), { code: '40P01' })]]));
    await expect(runRepair(ctx(), handler, await resolveRepairScope(engine), { apply: true, expect: 'stub-hash', explicit: true })).rejects.toThrow('deadlock detected');
  }, 60_000);

  test('a termination signal stops the apply before its next item with a result, and the same command resumes', async () => {
    await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='repair'");
    const stop = new AbortController();
    const { handler, applied } = stub(new Map());
    const apply = handler.apply.bind(handler);
    handler.apply = async (ctx, item, opts) => { const outcome = await apply(ctx, item, opts); if (item.cursor.id === 1) stop.abort('SIGTERM'); return outcome; };
    const scope = await resolveRepairScope(engine);
    const first = await runRepair(ctx(), handler, scope, { apply: true, expect: 'stub-hash', explicit: true, stop: stop.signal });
    expect(applied).toEqual([1]);
    expect(first).toMatchObject({ applied: 1, complete: false, stopped: { reason: 'interrupted' } });
    expect(first.stopped!.message).toBe(`Stopped before default:notes/p2: this process received SIGTERM (2 item(s) still pending; the items before it stay applied). Rerun \`${first.apply_command}\` to resume.`);
    const second = await runRepair(ctx(), handler, scope, { apply: true, expect: 'stub-hash', explicit: true, recordDatabaseStops: true });
    expect(applied).toEqual([1, 2, 3]);
    expect(second).toMatchObject({ applied: 2, complete: true });
  }, 60_000);
});
