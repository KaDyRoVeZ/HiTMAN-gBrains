/**
 * #7240: in a large deployment every dream synthesize run failed right after fan-out with Postgres 22P02 ("invalid
 * input syntax for type json") and its private-queue cleanup cancelled every child it had queued, so synthesize
 * children were cancelled ~17 s after creation and none ever ran. Two causes, two fixes:
 *   - a child payload with a lone UTF-16 surrogate (or U+0000) was refused by the JSONB insert: queue.add now stores
 *     such strings well-formed (U+FFFD), for every submitter;
 *   - one transcript whose child could not be queued failed the whole phase: it is now skipped (submit_failed) with
 *     its own chunks rolled back, and every other transcript's children still run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { runPhaseSynthesize, TRIAGE_VERSION } from '../src/core/cycle/synthesize.ts';
import { TIER_DEFAULTS } from '../src/core/model-config.ts';

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

describe('#7240 queue.add stores JSONB-unsafe strings well-formed', () => {
  test('a lone surrogate or U+0000 in job data no longer refuses the insert', async () => {
    const queue = new MinionQueue(engine);
    const job = await queue.add('subagent', { prompt: 'split emoji \ud83d here', note: 'nul \u0000 byte', nested: [{ k: '\udc00' }] },
      { queue: 'dream-inline-1-abcdef12' }, { allowProtectedSubmit: true });
    const row = (await queue.getJob(job.id))!;
    expect(row.data).toMatchObject({ prompt: 'split emoji \uFFFD here', note: 'nul \uFFFD byte', nested: [{ k: '\uFFFD' }] });
  });
});

describe('#7240 one transcript that cannot be queued does not cancel the run', () => {
  test('the failing transcript is skipped submit_failed; the others are queued and not reconciled away', async () => {
    const brainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-7240-brain-'));
    const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-7240-corpus-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-7240-home-'));
    await engine.setConfig('dream.synthesize.enabled', 'true');
    await engine.setConfig('dream.synthesize.session_corpus_dir', corpusDir);
    for (const name of ['2026-08-01-a.txt', '2026-08-02-b.txt', '2026-08-03-c.txt']) {
      const content = `conversation in ${name}\n`.repeat(200);
      const filePath = path.join(corpusDir, name);
      fs.writeFileSync(filePath, content);
      await engine.putDreamVerdict(filePath, createHash('sha256').update(content, 'utf8').digest('hex'), {
        worth_processing: true, reasons: ['seed'], score: 0.9, content_type: null, segments: [], entities: [],
        model: TIER_DEFAULTS.utility, triage_version: TRIAGE_VERSION,
      });
    }
    const realAdd = MinionQueue.prototype.add;
    MinionQueue.prototype.add = async function (this: MinionQueue, ...args: Parameters<typeof realAdd>) {
      if (String((args[1] as { prompt?: unknown } | undefined)?.prompt ?? '').includes('2026-08-02-b.txt')) {
        throw Object.assign(new Error('invalid input syntax for type json'), { code: '22P02' });
      }
      return realAdd.apply(this, args);
    };
    let result: Awaited<ReturnType<typeof runPhaseSynthesize>>;
    let cancelledAtDrain: Array<{ status: string; error_text: string | null }> = [];
    const drainSeam = MinionQueue.prototype.claim;
    MinionQueue.prototype.claim = async function (this: MinionQueue, ...args: Parameters<typeof drainSeam>) {
      cancelledAtDrain = await engine.executeRaw(`SELECT status, error_text FROM minion_jobs WHERE name = 'subagent'`);
      await engine.executeRaw(`UPDATE minion_jobs SET status = 'cancelled', finished_at = now(), error_text = 'test: stop before run' WHERE name = 'subagent' AND status = 'waiting'`);
      return null;
    };
    try {
      result = await withEnv({ ANTHROPIC_API_KEY: undefined, GBRAIN_HOME: tmpHome }, () =>
        runPhaseSynthesize(engine, { brainDir, dryRun: false }));
    } finally {
      MinionQueue.prototype.add = realAdd;
      MinionQueue.prototype.claim = drainSeam;
      for (const d of [brainDir, corpusDir, tmpHome]) fs.rmSync(d, { recursive: true, force: true });
    }
    expect(String(result.error?.code ?? '')).not.toBe('SYNTH_PHASE_FAIL');
    // The drain saw both healthy transcripts' children still waiting (not reconciled away by a phase failure).
    expect(cancelledAtDrain.map(r => r.status)).toEqual(['waiting', 'waiting']);
    const skips = (result.details as { skips?: Array<{ filePath: string; reason: string }> }).skips ?? [];
    expect(skips).toEqual([expect.objectContaining({ filePath: expect.stringContaining('2026-08-02-b.txt'), reason: 'submit_failed (22P02): invalid input syntax for type json' })]);
  }, 60_000);
});
