/**
 * #5867 (managed Gmail sweeps enqueue loops_extract; managed 30-day catch-up)
 * and #5868 (grace-held threads are re-evaluated after their deadline).
 *
 * Authoring gate. (1) Protects open-loop coverage for Gmail sources: managed
 * autopilot syncs must queue commitment extraction, threads missed before
 * this fix are analyzed once, and a quiet thread inside its grace window opens
 * its loop once the window passes. (2) Fails on the baseline: a managed sweep
 * with the autopilot `noExtract` default queued nothing, there was no
 * catch-up, and a held thread with no new Gmail history never opened. (3) The
 * existing connector tests cover delta/backfill cursors and item holds, never
 * the loop engine's lifecycle across sweeps. (4) Serial: the clock is moved
 * with setSystemTime and the chat transport is the gateway's process-global
 * seam.
 */
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { readGoogleState } from '../src/core/google/google-source.ts';
import { GRACE_REFETCH_PER_SWEEP } from '../src/core/google/loop-catchup.ts';
import { makeLoopsExtractHandler } from '../src/core/minions/handlers/loops-extract.ts';
import { makeSyncHandler } from '../src/core/minions/handlers/sync.ts';
import { connectorHeldItemsCheck } from '../src/commands/doctor/checks/connector-holds.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { __clearSuppressionCacheForTests } from '../src/core/google/loop-detect.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig, sourceCheckpoint, withGoogleAccount } from './helpers/connector-fixture.ts';
import type { GoogleSourceState } from '../src/core/google/types.ts';

const fixture = createConnectorFixture();
const { engines, env, source } = fixture;
beforeAll(fixture.setup, 120_000);
afterAll(async () => { __setChatTransportForTests(null); resetGateway(); await fixture.teardown(); });
afterEach(() => setSystemTime());

const b64url = (s: string) => Buffer.from(s, 'utf-8').toString('base64url');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const usage = { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 };

function chatReady(): void {
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  __setChatTransportForTests(async (): Promise<ChatResult> => ({ text: JSON.stringify({ commitments: [], decisions_pending: [] }),
    blocks: [], stopReason: 'end', usage, model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic' }));
}

interface FakeThread { tid: string; ms: number; body?: string }

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: unknown) => { lines.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try { return { result: await fn(), lines }; } finally { process.stderr.write = write; }
}

/** A minimal Gmail: profile, sendAs, windowed listing, a history cursor and thread reads (counted). */
function fakeGmail(account: string, threads: FakeThread[]) {
  const gmail = { historyId: '1000', flagged: [] as string[], threadReads: [] as string[], threads, unlisted: new Set<string>() };
  const fetcher = async (url: string) => {
    const u = new URL(url);
    if (u.pathname.endsWith('/settings/sendAs')) return json({ sendAs: [] });
    if (u.pathname.endsWith('/users/me/profile')) return json({ emailAddress: account, historyId: gmail.historyId });
    if (u.pathname.endsWith('/users/me/messages')) {
      const q = u.searchParams.get('q') ?? '';
      const after = Number(/after:(\d+)/.exec(q)?.[1] ?? 0);
      const before = Number(/before:(\d+)/.exec(q)?.[1] ?? Infinity);
      const hits = gmail.threads.filter((t) => !gmail.unlisted.has(t.tid) && t.ms / 1000 >= after && t.ms / 1000 < before).sort((a, b) => b.ms - a.ms);
      return json({ messages: hits.map((t) => ({ id: `m${t.tid}`, threadId: t.tid })) });
    }
    if (u.pathname.endsWith('/users/me/history')) {
      const records = u.searchParams.get('startHistoryId') === gmail.historyId ? [] : [{ messages: gmail.flagged.map((threadId) => ({ threadId })) }];
      return json({ historyId: gmail.historyId, history: records });
    }
    const m = u.pathname.match(/\/users\/me\/threads\/([^/]+)$/);
    if (m) {
      gmail.threadReads.push(m[1]);
      const t = gmail.threads.find((x) => x.tid === m[1]);
      if (!t) return json({ error: { code: 404, message: 'Requested entity was not found.' } }, 404);
      return json({ id: t.tid, messages: [{ id: `m${t.tid}`, threadId: t.tid, labelIds: ['INBOX'], internalDate: String(t.ms),
        payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'Peer Example <peer@example.invalid>' },
          { name: 'To', value: account }, { name: 'Subject', value: `Topic ${t.tid}` }],
        body: { data: b64url(t.body ?? `Can you review the plan for ${t.tid}?`) } } }] });
    }
    return json({ error: { message: 'unexpected fixture route' } }, 400);
  };
  return { gmail, fetcher };
}

async function gmailSource(engine: BrainEngine, managed: boolean) {
  const config = { ...googleConfig, g_services: 'gmail', g_history_days: 90 };
  const f = await source(engine, config);
  if (!managed) {
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  }
  return { ...f, cfg: parseGoogleSourceConfig(config, f.dir) };
}

async function restoreManaged(engine: BrainEngine) {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
}

async function googleState(engine: BrainEngine, f: { id: string; dir: string }, managed: boolean): Promise<GoogleSourceState | undefined> {
  if (!managed) return readGoogleState(f.dir);
  await disposePersistenceConsumer(engine);
  const [row] = await sourceCheckpoint(engine, f.id) as { completed_keys: { state?: GoogleSourceState }[] }[];
  return row?.completed_keys[0]?.state;
}

const loopsJobs = (engine: BrainEngine, sourceId: string) => engine.executeRaw<{ id: number; data: Record<string, unknown>; status: string; idempotency_key: string }>(
  "SELECT id, data, status, idempotency_key FROM minion_jobs WHERE name='loops_extract' AND data->>'sourceId'=$1 ORDER BY id", [sourceId]);

/** Runs every waiting loops_extract job of the source through the real handler and completes it. */
async function drainLoopsJobs(engine: BrainEngine, sourceId: string): Promise<void> {
  const handler = makeLoopsExtractHandler(engine);
  for (const job of await loopsJobs(engine, sourceId)) {
    if (job.status !== 'waiting') continue;
    await handler({ id: job.id, data: job.data } as never);
    await engine.executeRaw("UPDATE minion_jobs SET status='completed' WHERE id=$1", [job.id]);
  }
}

describe('#5867 managed Gmail sweeps enqueue loops_extract', () => {
  test('an autopilot-shaped managed sweep (noExtract) queues the eligible thread and reports loops_enqueue', async () => withEnv(env, async () => {
    chatReady();
    for (const engine of engines) {
      await engine.setConfig('loops.extraction_enabled', 'true');
      const f = await gmailSource(engine, true);
      const { gmail, fetcher } = fakeGmail(f.cfg.account, [{ tid: '17aa00000000e001', ms: Date.now() - 2 * DAY }]);
      const result = await runGoogleSync(engine, f.id, f.cfg, { ...options, noExtract: true }, withGoogleAccount(fetcher, f.cfg.account));
      const jobs = await loopsJobs(engine, f.id);
      expect(jobs.filter((j) => j.idempotency_key.startsWith('loops:'))).toHaveLength(1);
      expect(jobs.map((j) => j.data.slug)).toEqual([jobs[0].data.slug]);
      expect((result as { loops_enqueue?: unknown }).loops_enqueue).toMatchObject({ enqueued: 1, deferred: 0, skipped_reason: null });
      expect(gmail.threadReads.length).toBeGreaterThan(0);
      await disposePersistenceConsumer(engine);
    }
  }), 180_000);

  test('the autopilot dispatch → sync handler chain on a managed source queues loops_extract', async () => withEnv(env, async () => {
    chatReady();
    for (const engine of engines) {
      await engine.setConfig('loops.extraction_enabled', 'true');
      const f = await gmailSource(engine, true);
      const { gmail, fetcher } = fakeGmail(f.cfg.account, [{ tid: '17aa00000000e051', ms: Date.now() - 2 * DAY }]);
      const realFetch = globalThis.fetch;
      globalThis.fetch = withGoogleAccount(fetcher, f.cfg.account) as typeof fetch;
      try {
        // The job data autopilot-dispatch's connector freshness sync submits (no noExtract: the handler defaults it to true).
        await makeSyncHandler(engine)({ id: 1, name: 'sync', data: { sourceId: f.id, pull: false, auto_embed_backfill: true, embed_reason: 'autopilot_freshness' },
          signal: new AbortController().signal, updateProgress: async () => {}, log: async () => {} } as never);
      } finally { globalThis.fetch = realFetch; }
      expect(gmail.threadReads.length).toBeGreaterThan(0);
      expect((await loopsJobs(engine, f.id)).filter((j) => j.idempotency_key.startsWith('loops:'))).toHaveLength(1);
      await disposePersistenceConsumer(engine);
    }
  }), 180_000);

  test('the kill switch logs a skip and queues nothing on the sweep or the catch-up', async () => withEnv(env, async () => {
    chatReady();
    for (const engine of engines) {
      await engine.setConfig('loops.extraction_enabled', 'false');
      const f = await gmailSource(engine, true);
      const { fetcher } = fakeGmail(f.cfg.account, [{ tid: '17aa00000000e101', ms: Date.now() - 2 * DAY }]);
      const { result, lines: logs } = await captureStderr(() =>
        runGoogleSync(engine, f.id, f.cfg, { ...options, noExtract: true }, withGoogleAccount(fetcher, f.cfg.account)));
      expect(await loopsJobs(engine, f.id)).toHaveLength(0);
      expect(logs.some((l) => l.includes('loops_extract: extraction disabled'))).toBe(true);
      expect(logs.some((l) => l.includes('loops catch-up skipped (extraction_disabled)'))).toBe(true);
      expect((result as { loops_enqueue?: unknown }).loops_enqueue).toMatchObject({ enqueued: 0, skipped_reason: 'extraction_disabled' });
      expect((await googleState(engine, f, true))?.loops_catchup?.done ?? false).toBe(false);
      await engine.setConfig('loops.extraction_enabled', 'true');
    }
  }), 180_000);

  test('catch-up analyzes a thread whose job ran while extraction was disabled, including one with a deterministic loop row, once', async () => withEnv(env, async () => {
    chatReady();
    for (const engine of engines) {
      await engine.setConfig('loops.extraction_enabled', 'true');
      const f = await gmailSource(engine, true);
      const tid = '17aa00000000e201';
      const { fetcher } = fakeGmail(f.cfg.account, [{ tid, ms: Date.now() - 3 * DAY }]);
      const sync = () => runGoogleSync(engine, f.id, f.cfg, { ...options, noExtract: true }, withGoogleAccount(fetcher, f.cfg.account));
      // Sweep 1 queues the thread through the normal enqueue; its job then runs while extraction is off.
      await sync();
      expect(await engine.executeRaw("SELECT 1 FROM open_loops WHERE source_id=$1 AND loop_type='unanswered_inbound' AND status='open'", [f.id])).toHaveLength(1);
      await engine.setConfig('loops.extraction_enabled', 'false');
      await drainLoopsJobs(engine, f.id);
      await engine.setConfig('loops.extraction_enabled', 'true');
      // Sweep 2 (no new mail): the catch-up re-candidates it under its own key.
      await sync();
      let jobs = await loopsJobs(engine, f.id);
      expect(jobs.filter((j) => j.idempotency_key.startsWith('loops-catchup:'))).toHaveLength(1);
      await drainLoopsJobs(engine, f.id);
      // Sweep 3 settles the catch-up; sweep 4 does not repeat it.
      await sync();
      expect((await googleState(engine, f, true))?.loops_catchup?.done).toBe(true);
      await sync();
      jobs = await loopsJobs(engine, f.id);
      expect(jobs).toHaveLength(2);
    }
  }), 240_000);

  test('a dead-lettered catch-up job is retried once, then given up', async () => withEnv(env, async () => {
    chatReady();
    for (const engine of engines) {
      await engine.setConfig('loops.extraction_enabled', 'false');
      const f = await gmailSource(engine, true);
      const { fetcher } = fakeGmail(f.cfg.account, [{ tid: '17aa00000000e301', ms: Date.now() - 4 * DAY }]);
      const sync = () => runGoogleSync(engine, f.id, f.cfg, { ...options, noExtract: true }, withGoogleAccount(fetcher, f.cfg.account));
      await sync(); // imports the page; nothing queued
      await engine.setConfig('loops.extraction_enabled', 'true');
      await sync();
      const kill = async () => engine.executeRaw("UPDATE minion_jobs SET status='dead' WHERE name='loops_extract' AND data->>'sourceId'=$1 AND status='waiting'", [f.id]);
      await kill();
      await sync();
      expect((await loopsJobs(engine, f.id)).map((j) => j.idempotency_key.endsWith(':retry'))).toEqual([false, true]);
      await kill();
      await sync();
      expect(await loopsJobs(engine, f.id)).toHaveLength(2);
      expect((await googleState(engine, f, true))?.loops_catchup?.done).toBe(true);
    }
  }), 240_000);

  test('an aborted sweep leaves the catch-up and backfill markers unset', async () => withEnv(env, async () => {
    chatReady();
    for (const engine of engines) {
      await engine.setConfig('loops.extraction_enabled', 'true');
      const f = await gmailSource(engine, true);
      const { fetcher } = fakeGmail(f.cfg.account, [{ tid: '17aa00000000e401', ms: Date.now() - 2 * DAY }]);
      const controller = new AbortController();
      controller.abort();
      await runGoogleSync(engine, f.id, f.cfg, { ...options, signal: controller.signal }, withGoogleAccount(fetcher, f.cfg.account)).catch(() => null);
      const state = await googleState(engine, f, true);
      expect(state?.loops_catchup?.done ?? false).toBe(false);
      expect(state?.loop_grace_backfill_done ?? false).toBe(false);
      expect(await loopsJobs(engine, f.id)).toHaveLength(0);
    }
  }), 120_000);
});

describe('#5868 grace-held threads are re-evaluated after their deadline', () => {
  for (const managed of [true, false]) {
    test(`${managed ? 'managed' : 'unmanaged'}: a quiet held thread opens its loop on the sweep after its deadline with no Gmail read`, async () => withEnv(env, async () => {
      for (const engine of engines) {
        await engine.setConfig('loops.extraction_enabled', 'false');
        const f = await gmailSource(engine, managed);
        __clearSuppressionCacheForTests(engine);
        const tid = '17aa00000000f001';
        const { gmail, fetcher } = fakeGmail(f.cfg.account, [{ tid, ms: Date.now() - 2 * HOUR }]);
        const sync = () => runGoogleSync(engine, f.id, f.cfg, { ...options }, withGoogleAccount(fetcher, f.cfg.account));
        await sync();
        const openLoops = () => engine.executeRaw<{ loop_type: string }>("SELECT loop_type FROM open_loops WHERE source_id=$1 AND status='open'", [f.id]);
        expect(await openLoops()).toHaveLength(0);
        const held = (await googleState(engine, f, managed))?.loop_grace_holds?.[tid];
        expect(held?.spec?.loopType).toBe('unanswered_inbound');
        setSystemTime(new Date(Date.now() + 26 * HOUR));
        gmail.threadReads.length = 0;
        await sync();
        expect((await openLoops()).map((r) => r.loop_type)).toEqual(['unanswered_inbound']);
        expect(gmail.threadReads).toEqual([]);
        expect((await googleState(engine, f, managed))?.loop_grace_holds?.[tid]).toBeUndefined();
        setSystemTime();
        if (!managed) await restoreManaged(engine);
      }
    }), 180_000);
  }

  test('a 500-thread backfill is bounded per sweep, never exhausts item holds, and leaves connector_held_items unchanged', async () => withEnv(env, async () => {
    for (const engine of engines) {
      await engine.setConfig('loops.extraction_enabled', 'false');
      const f = await gmailSource(engine, false);
      const threads = Array.from({ length: 500 }, (_, i) => ({ tid: `17ab0000000${String(i).padStart(5, '0')}`, ms: Date.now() - (5 * DAY + i * 60_000) }));
      // Pages exist from before the fix (no holds recorded); Gmail lists none of them again.
      for (const t of threads) {
        await engine.putPage(`emails/${t.tid}`, { title: `Topic ${t.tid}`, type: 'email', compiled_truth: 'Synthetic body.',
          frontmatter: { thread_id: t.tid, message_id: `m${t.tid}`, date: new Date(t.ms).toISOString() } }, { sourceId: f.id });
      }
      const { gmail, fetcher } = fakeGmail(f.cfg.account, threads);
      for (const t of threads) gmail.unlisted.add(t.tid);
      const before = await connectorHeldItemsCheck(engine, [f.id]);
      const result = await runGoogleSync(engine, f.id, f.cfg, { ...options }, withGoogleAccount(fetcher, f.cfg.account));
      expect(result.status).not.toBe('partial');
      expect(gmail.threadReads).toHaveLength(GRACE_REFETCH_PER_SWEEP);
      const state = readGoogleState(f.dir);
      expect(state.loop_grace_backfill_done).toBe(true);
      expect(Object.keys(state.loop_grace_holds ?? {}).length).toBe(500 - GRACE_REFETCH_PER_SWEEP);
      expect((await connectorHeldItemsCheck(engine, [f.id])).status).toBe(before.status);
      expect((await connectorHeldItemsCheck(engine, [f.id])).message).toBe(before.message);
      // Each re-fetched thread is past its grace window, so it opened; the rest wait for later sweeps.
      expect((await engine.executeRaw("SELECT 1 FROM open_loops WHERE source_id=$1 AND status='open'", [f.id])).length).toBe(GRACE_REFETCH_PER_SWEEP);
      await restoreManaged(engine);
    }
  }), 240_000);

  test('E20: a partial managed sweep still publishes grace holds and the catch-up cursor', async () => withEnv(env, async () => {
    chatReady();
    for (const engine of engines) {
      await engine.setConfig('loops.extraction_enabled', 'false');
      const f = await gmailSource(engine, true);
      const good = { tid: '17aa00000000f101', ms: Date.now() - 2 * HOUR };
      const { gmail, fetcher } = fakeGmail(f.cfg.account, []);
      await runGoogleSync(engine, f.id, f.cfg, { ...options }, withGoogleAccount(fetcher, f.cfg.account));
      expect((await googleState(engine, f, true))?.loops_catchup).toBeUndefined();
      gmail.threads.push(good);
      await engine.setConfig('loops.extraction_enabled', 'true');
      // Sweep 2: history flags the held thread plus one that fails to read → a partial run.
      gmail.historyId = '1010';
      gmail.flagged = [good.tid, '17aa00000000f1ff'];
      const failing = async (url: string, init?: RequestInit) => url.includes('17aa00000000f1ff')
        ? json({ error: { message: 'fixture failure' } }, 400) : fetcher(url);
      const result = await runGoogleSync(engine, f.id, f.cfg, { ...options }, withGoogleAccount(failing, f.cfg.account));
      expect(result.status).toBe('partial');
      const state = await googleState(engine, f, true);
      // Written after the sweep's last mid-run checkpoint, so only the partial-run publication carries them.
      expect(state?.loop_grace_holds?.[good.tid]?.spec?.loopType).toBe('unanswered_inbound');
      expect(state?.loops_catchup).toMatchObject({ done: false });
      expect(state?.loop_grace_backfill_done).toBe(true);
    }
  }), 180_000);
});
