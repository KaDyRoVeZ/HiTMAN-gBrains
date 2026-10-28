#!/usr/bin/env bun
/**
 * Synthetic minions job-load fixture (#7239, #7240). In-memory PGLite, no network, no model calls. Run it on two trees
 * to compare (`bun scripts/bench-minions-load.ts --json`):
 *
 *   retry_burn: autopilot's freshness dispatch for SOURCES sources whose sync is deterministically refused (a managed
 *   refusal, `writer_coordinator_required`), one dispatch per 5-minute slot for a simulated day, a real MinionWorker
 *   draining each slot. History is aged by one slot between slots, so the dispatch's cooldowns see real elapsed time.
 *   Reports sync jobs created, handler attempts and deaths per source-day.
 *
 *   cancel_churn: a dream-style private queue: CHILDREN subagent children submitted up front, an inline drain with a
 *   parent deadline that fits only some of them, then the phase's cleanup. Reports completed vs cancelled children.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { dispatchFreshnessSyncs } from '../src/commands/autopilot-dispatch.ts';
import { opError } from '../src/core/ops/contract.ts';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { runPhaseSynthesize, TRIAGE_VERSION } from '../src/core/cycle/synthesize.ts';
import { TIER_DEFAULTS } from '../src/core/model-config.ts';

const json = process.argv.includes('--json');
const SOURCES = 3;
const SLOT_MIN = 5;
const SLOTS = (24 * 60) / SLOT_MIN;

process.env.GBRAIN_HOME = mkdtempSync(join(tmpdir(), 'gbrain-minions-load-'));
const engine = new PGLiteEngine();
await engine.connect({});
await engine.initSchema();
const queue = new MinionQueue(engine);

const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => {
  const write = process.stderr.write.bind(process.stderr);
  const log = console.log, warn = console.warn;
  (process.stderr as { write: unknown }).write = () => true;
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { (process.stderr as { write: unknown }).write = write; console.log = log; console.warn = warn; }
};

async function drain(): Promise<void> {
  const worker = new MinionWorker(engine, { pollInterval: 10 });
  worker.register('sync', async () => {
    attempts++;
    throw opError('writer_coordinator_required', 'Managed sync requires skipping the Git pull.', 'Sync with --no-pull.');
  });
  const running = worker.start();
  for (let i = 0; i < 500; i++) {
    await engine.executeRaw(`UPDATE minion_jobs SET delay_until = now() WHERE status = 'delayed'`);
    const [{ n }] = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM minion_jobs WHERE name='sync' AND status IN ('waiting','active','delayed')`);
    if (n === 0) break;
    await new Promise(r => setTimeout(r, 15));
  }
  worker.stop();
  await running;
}

let attempts = 0;
for (let i = 0; i < SOURCES; i++) {
  const id = `source-${String.fromCharCode(97 + i)}`;
  const dir = join(process.env.GBRAIN_HOME!, id);
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-C', dir, 'init', '-q']);
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, dir, '{}']);
}
await quiet(async () => {
  for (let slot = 0; slot < SLOTS; slot++) {
    await dispatchFreshnessSyncs(engine, queue, { baseInterval: SLOT_MIN * 60, slot: `slot-${slot}`, timeoutMs: 60_000, jsonMode: true });
    await drain();
    await engine.executeRaw(`UPDATE minion_jobs SET created_at = created_at - interval '${SLOT_MIN} minutes',
      finished_at = finished_at - interval '${SLOT_MIN} minutes', updated_at = updated_at - interval '${SLOT_MIN} minutes'`);
  }
});
const [burn] = await engine.executeRaw<{ jobs: number; dead: number }>(`SELECT count(*)::int AS jobs, count(*) FILTER (WHERE status='dead')::int AS dead FROM minion_jobs WHERE name='sync'`);
const retryBurn = { sources: SOURCES, slots: SLOTS, sync_jobs: burn.jobs, handler_attempts: attempts, deaths: burn.dead,
  deaths_per_source_day: +(burn.dead / SOURCES).toFixed(1), attempts_per_job: +(attempts / Math.max(1, burn.jobs)).toFixed(2) };

// cancel_churn: TRANSCRIPTS passing transcripts; the payload of one (BAD_AT) carries a lone UTF-16 surrogate, the shape
// a large deployment's synthesize payloads hit. The drain is replaced by a seam that marks every waiting child as run,
// so the numbers count children that reached the drain vs children cancelled before running.
const TRANSCRIPTS = 10, BAD_AT = 5;
await engine.executeRaw('DELETE FROM minion_jobs');
const corpusDir = mkdtempSync(join(tmpdir(), 'gbrain-minions-load-corpus-'));
await engine.setConfig('dream.synthesize.enabled', 'true');
await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
for (let i = 0; i < TRANSCRIPTS; i++) {
  const name = `2026-08-${String(i + 1).padStart(2, '0')}-t${i}.txt`;
  const content = `conversation ${i}\n`.repeat(200);
  writeFileSync(join(corpusDir, name), content);
  await engine.putDreamVerdict(join(corpusDir, name), createHash('sha256').update(content, 'utf8').digest('hex'), {
    worth_processing: true, reasons: ['seed'], score: 0.9, content_type: null, segments: [], entities: [], model: TIER_DEFAULTS.utility, triage_version: TRIAGE_VERSION,
  });
}
const realAdd = MinionQueue.prototype.add, realClaim = MinionQueue.prototype.claim;
MinionQueue.prototype.add = async function (this: MinionQueue, ...args: Parameters<typeof realAdd>) {
  const data = args[1] as { prompt?: string } | undefined;
  if (typeof data?.prompt === 'string' && data.prompt.includes(`-t${BAD_AT}.txt`)) args[1] = { ...data, prompt: data.prompt + ' \ud83d' };
  return realAdd.apply(this, args);
};
MinionQueue.prototype.claim = async function () {
  await engine.executeRaw(`UPDATE minion_jobs SET status = 'completed', started_at = now(), finished_at = now() WHERE name = 'subagent' AND status = 'waiting'`);
  return null;
};
let phase: Awaited<ReturnType<typeof runPhaseSynthesize>>;
try {
  phase = await quiet(() => runPhaseSynthesize(engine, { brainDir: mkdtempSync(join(tmpdir(), 'gbrain-minions-load-brain-')), dryRun: false }));
} finally {
  MinionQueue.prototype.add = realAdd;
  MinionQueue.prototype.claim = realClaim;
}
const [churn] = await engine.executeRaw<{ created: number; ran: number; cancelled: number }>(
  `SELECT count(*)::int AS created, count(*) FILTER (WHERE started_at IS NOT NULL)::int AS ran,
          count(*) FILTER (WHERE status = 'cancelled' AND started_at IS NULL)::int AS cancelled FROM minion_jobs WHERE name = 'subagent'`);
const cancelChurn = { transcripts: TRANSCRIPTS, children_created: churn.created, children_reached_drain: churn.ran,
  children_cancelled_unrun: churn.cancelled, phase_error: phase.error?.code ?? null };

const out = { retry_burn: retryBurn, cancel_churn: cancelChurn };
await engine.disconnect();
if (json) console.log(JSON.stringify(out, null, 2));
else console.log(`cancel_churn: ${cancelChurn.children_created} children, ${cancelChurn.children_reached_drain} reached the drain, ${cancelChurn.children_cancelled_unrun} cancelled unrun (phase error ${cancelChurn.phase_error})`), console.log(`retry_burn: ${retryBurn.sync_jobs} sync jobs, ${retryBurn.handler_attempts} handler attempts, ${retryBurn.deaths} deaths (${retryBurn.deaths_per_source_day}/source-day, ${retryBurn.attempts_per_job} attempts/job)`);
