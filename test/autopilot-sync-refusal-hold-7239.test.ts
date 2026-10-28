/**
 * #7239: a sync job refused by a deterministic refusal (job_outcome 'refused') is refused again until its cause is
 * fixed, so autopilot's freshness dispatch stops queueing one per slot: the source waits out the failure cooldown for
 * its refusal count, the hold is stated once per refused job, and a completed sync job clears it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { dispatchFreshnessSyncs, readSyncRefusalHolds } from '../src/commands/autopilot-dispatch.ts';

let engine: PGLiteEngine;
let home: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', String(LATEST_VERSION));
  home = mkdtempSync(join(tmpdir(), 'gbrain-7239-'));
});

const inHome = <T,>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home }, fn);
async function checkoutSource(id: string): Promise<void> {
  const dir = join(home, id);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-C', dir, 'init', '-q']);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, dir, '{}']);
}
async function settledSync(sourceId: string, outcome: 'refused' | 'completed', minutesAgo = 0): Promise<number> {
  const result = outcome === 'refused' ? { job_outcome: 'refused', refusal: { code: 'writer_coordinator_required', message: 'm', docs_cmd: ['gbrain', 'errors', 'writer_coordinator_required'] } } : { ok: true };
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, queue, status, data, result, finished_at, submission_authority)
     VALUES ('sync', 'default', $1, $2::text::jsonb, $3::text::jsonb, now() - ($4::int * interval '1 minute'), '{"kind":"trusted_local","version":1}'::jsonb) RETURNING id`,
    [outcome === 'refused' ? 'dead' : 'completed', JSON.stringify({ sourceId }), JSON.stringify(result), minutesAgo],
  );
  return row.id;
}
const waitingSyncs = async () => (await engine.executeRaw<{ src: string }>("SELECT data->>'sourceId' AS src FROM minion_jobs WHERE name='sync' AND status='waiting' ORDER BY id")).map(r => r.src);

async function tick(): Promise<Array<Record<string, unknown>>> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  const log = console.log;
  (process.stderr as { write: unknown }).write = (chunk: unknown) => { lines.push(String(chunk)); return true; };
  console.log = () => {};
  try {
    await dispatchFreshnessSyncs(engine, new MinionQueue(engine), { baseInterval: 60, slot: `slot-${Math.random()}`, timeoutMs: 60_000, jsonMode: true });
  } finally {
    (process.stderr as { write: unknown }).write = write;
    console.log = log;
  }
  return lines.flatMap(l => l.split('\n')).filter(Boolean).map(l => JSON.parse(l));
}

describe('#7239 refused automatic syncs back off', () => {
  test('a source whose last sync job was refused gets no new sync job this slot; its neighbour still does', () => inHome(async () => {
    await checkoutSource('source-a');
    await checkoutSource('source-b');
    const refused = await settledSync('source-a', 'refused');
    const first = await tick();
    const second = await tick();
    expect(await waitingSyncs()).toEqual(['source-b']);
    const holds = [...first, ...second].filter(e => e.event === 'freshness_sync_refused');
    expect(holds).toEqual([expect.objectContaining({ source_id: 'source-a', job_id: refused, code: 'writer_coordinator_required', refusals: 1 })]);
  }));

  test('the hold grows with consecutive refusals and lapses after its cooldown', () => inHome(async () => {
    await settledSync('source-a', 'refused', 11);
    expect((await readSyncRefusalHolds(engine)).has('source-a')).toBe(false);
    await settledSync('source-a', 'refused', 5);
    const hold = (await readSyncRefusalHolds(engine)).get('source-a');
    expect(hold?.count).toBe(2);
    expect(hold!.retry_at - Date.now()).toBeGreaterThan(14 * 60_000);
  }));

  test('a completed sync job after the refusal clears the hold, and the cooldown knob at 0 disables it', () => inHome(async () => {
    await checkoutSource('source-a');
    await settledSync('source-a', 'refused', 2);
    expect((await readSyncRefusalHolds(engine)).has('source-a')).toBe(true);
    await engine.setConfig('autopilot.failure_cooldown_min', '0');
    expect((await readSyncRefusalHolds(engine)).size).toBe(0);
    await engine.setConfig('autopilot.failure_cooldown_min', '10');
    await settledSync('source-a', 'completed', 1);
    expect((await readSyncRefusalHolds(engine)).size).toBe(0);
    await tick();
    expect(await waitingSyncs()).toEqual(['source-a']);
  }));
});
