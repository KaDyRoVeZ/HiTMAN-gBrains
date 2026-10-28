/**
 * #5887 — the sweep's corpus pass extracts whole transcripts, window by
 * window, across sweeps; the compact harvest extracts window 1 only.
 *
 * Protects: facts past the extractor's 8,000-char head are extracted; a long
 * file converges over sweeps under the per-file (8) and per-sweep (32) caps
 * with no window sent twice; appends, compaction remainders and same-size or
 * shorter rewrites cost only their new turns; legacy `.ingested` files stay
 * done; a sweep whose claim the hook deleted never re-extracts the window
 * another sweep is working on; a retried harvest never re-extracts window 1.
 * Fails on the pre-#5887 sweep, which sent each file once, head only.
 * Imports only modules that predate #5887 so it runs against the old tree.
 *
 * Hermetic in-memory PGLite + chat-transport stub (sweep.test.ts harness).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { CORPUS_CLAIM_SUFFIX, CORPUS_INGESTED_SUFFIX, runMaintenanceSweep, type SweepReport } from '../src/core/sweep.ts';
import { __setChatTransportForTests, type ChatResult } from '../src/core/ai/gateway.ts';
import type { CapabilityReport } from '../src/core/capability.ts';
import { toCorpusText } from '../src/core/transcripts/claude-code-jsonl.ts';
import {
  __drainCheckpointHarvestForTests,
  __resetCheckpointHarvestForTests,
  HARVEST_RECEIPT_SUFFIX,
  scheduleCheckpointHarvest,
} from '../src/core/context/checkpoint-harvest.ts';
import { appendSegmentLedger, segmentFileName, writeSegment } from '../src/core/context/corpus-segments.ts';
import { withEnv } from './helpers/with-env.ts';

const KEYED: CapabilityReport = {
  embeddings: { available: false },
  extraction: { available: true, provider: 'anthropic' },
  search: 'keyword-only',
  mode: 'keyed',
};

let engine: PGLiteEngine;
let dir: string;
const tmpDirs: string[] = [];
let inputs: string[];
let onCall: ((text: string, n: number) => Promise<void> | void) | null;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM facts').catch(() => {});
  dir = mkdtempSync(join(tmpdir(), 'gbrain-sweep-windows-'));
  tmpDirs.push(dir);
  await engine.setConfig('dream.synthesize.session_corpus_dir', dir);
  inputs = [];
  onCall = null;
  __resetCheckpointHarvestForTests();
  __setChatTransportForTests(async (request): Promise<ChatResult> => {
    const content = String(request.messages[0].content);
    const text = content.slice(content.indexOf('<turn>\n') + '<turn>\n'.length, content.lastIndexOf('\n</turn>'));
    inputs.push(text);
    if (onCall) await onCall(text, inputs.length);
    const facts = text.includes('TAILMARK')
      ? [{ fact: 'Prefers a quiet office for focused work', kind: 'preference', entity: null, confidence: 0.9, notability: 'high' }]
      : [];
    return {
      text: JSON.stringify({ facts }),
      blocks: [],
      stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:test-stub',
      providerId: 'anthropic',
    };
  });
});

afterEach(() => {
  __setChatTransportForTests(null);
});

const sweep = (): Promise<SweepReport> =>
  runMaintenanceSweep(engine, { sourceId: 'default', capabilities: KEYED, budgetMs: 120_000, batchLimit: 20 });

/** `T07 t07 detail words ...` padded to `n` chars — a unique, greppable turn body. */
const body = (tag: string, n = 5000): string => {
  let s = `${tag} `;
  while (s.length < n) s += `${tag.toLowerCase()} detail words\n`;
  return s.slice(0, n);
};
const turns = (count: number, from = 0, n = 5000): Array<['user' | 'assistant', string]> =>
  Array.from({ length: count }, (_, i) => [(from + i) % 2 === 0 ? 'user' : 'assistant', body(`T${String(from + i).padStart(2, '0')}`, n)]);
const corpus = (list: Array<['user' | 'assistant', string]>): string =>
  toCorpusText(list.map(([role, text]) => ({ role, text })));

/** The session-end hook's resume rewrite: atomic replace, then drop `.ingested` and the claim. */
function hookRewrite(file: string, text: string): void {
  writeFileSync(file + '.tmp-hook', text);
  renameSync(file + '.tmp-hook', file);
  rmSync(file + CORPUS_INGESTED_SUFFIX, { force: true });
  rmSync(file + CORPUS_CLAIM_SUFFIX, { force: true });
}

const markers = (texts: string[]): string[] => texts.flatMap((t) => t.match(/\b[RST]\d\d\b/g) ?? []);

describe('sweep corpus windows (#5887)', () => {
  test('a transcript past 8,000 chars reaches the extractor whole; every window opens with a role header', async () => {
    const file = join(dir, 'long.txt');
    writeFileSync(file, corpus([...turns(2), ['user', 'TAILMARK I prefer a quiet office for focused work.']]));
    const r = await sweep();
    expect(r.corpusIngested).toBe(1);
    expect(inputs.length).toBeGreaterThan(1);
    for (const t of inputs) {
      expect(t.length).toBeLessThanOrEqual(8000);
      expect(t).toMatch(/^\[(user|assistant)\]\n/);
    }
    expect(inputs.join('\n')).toContain('TAILMARK');
    const facts = await engine.executeRaw<{ fact: string }>(`SELECT fact FROM facts WHERE source = 'sweep:corpus'`);
    expect(facts.some((f) => f.fact.includes('quiet office'))).toBe(true);
  });

  test('a 20-window file finishes in three sweeps (8, 8, 4) with no window sent twice; corpus_files reports progress', async () => {
    const file = join(dir, 'twenty.txt');
    writeFileSync(file, corpus(turns(20)));
    const r1 = await sweep();
    expect(r1.corpus_files).toEqual([{ file: 'twenty.txt', windows_done: 8, windows_remaining: 12 }]);
    expect(existsSync(file + CORPUS_INGESTED_SUFFIX)).toBe(false);
    const r2 = await sweep();
    expect(r2.corpus_files).toEqual([{ file: 'twenty.txt', windows_done: 8, windows_remaining: 4 }]);
    const r3 = await sweep();
    expect(r3.corpus_files).toEqual([{ file: 'twenty.txt', windows_done: 4, windows_remaining: 0 }]);
    expect(r3.corpusIngested).toBe(1);
    expect(existsSync(file + CORPUS_INGESTED_SUFFIX)).toBe(true);
    expect(markers(inputs)).toEqual(turns(20).map(([, b]) => b.slice(0, 3)));
    const r4 = await sweep();
    expect(inputs.length).toBe(20);
    expect(r4.skipped).toContainEqual({ reason: 'already_ingested', count: 1 });
  });

  test('a resumed session that appends turns re-sends only the new turns', async () => {
    const file = join(dir, 'resume.txt');
    writeFileSync(file, corpus(turns(3)));
    await sweep();
    expect(markers(inputs)).toEqual(['T00', 'T01', 'T02']);
    inputs = [];
    hookRewrite(file, corpus(turns(4)));
    const r = await sweep();
    expect(r.corpusIngested).toBe(1);
    expect(markers(inputs)).toEqual(['T03']);
  });

  test('a compaction rewrite to the remainder re-extracts nothing', async () => {
    const file = join(dir, 'compacted.txt');
    writeFileSync(file, corpus(turns(4)));
    await sweep();
    inputs = [];
    hookRewrite(file, corpus(turns(2, 2)));
    const r = await sweep();
    expect(inputs).toEqual([]);
    expect(r.corpusIngested).toBe(1);
    expect(existsSync(file + CORPUS_INGESTED_SUFFIX)).toBe(true);
  });

  test('same-size and shorter rewrites of a finished file are re-extracted even when a stale .ingested survives', async () => {
    const file = join(dir, 'replaced.txt');
    const original = corpus(turns(2));
    writeFileSync(file, original);
    await sweep();
    inputs = [];
    const sameSize = original.replaceAll('T00', 'S00').replaceAll('t00', 's00');
    expect(Buffer.byteLength(sameSize)).toBe(Buffer.byteLength(original));
    writeFileSync(file + '.tmp-x', sameSize);
    renameSync(file + '.tmp-x', file);
    await sweep();
    // Resume is at the first unrecorded turn; turns after it are re-read.
    expect(markers(inputs)).toEqual(['S00', 'T01']);
    inputs = [];
    writeFileSync(file + '.tmp-x', corpus([['user', 'R00 a shorter replacement turn']]));
    renameSync(file + '.tmp-x', file);
    await sweep();
    expect(inputs.join('\n')).toContain('R00');
  });

  test('a legacy .ingested file is not re-extracted, and its later growth extracts only the appended turns', async () => {
    const file = join(dir, 'legacy.txt');
    writeFileSync(file, corpus(turns(3)));
    writeFileSync(file + CORPUS_INGESTED_SUFFIX, JSON.stringify({ ingested_at: new Date().toISOString() }) + '\n');
    const r1 = await sweep();
    expect(inputs).toEqual([]);
    expect(r1.skipped).toContainEqual({ reason: 'already_ingested', count: 1 });
    hookRewrite(file, corpus(turns(4)));
    await sweep();
    expect(markers(inputs)).toEqual(['T03']);
  });

  test('a 20,000-char pasted user turn puts zero paste text into any window', async () => {
    const paste = `<pasted_content id="7">\n${'PASTEMARK third-party text. '.repeat(720)}\n</pasted_content id="7">`;
    const file = join(dir, 'paste.txt');
    writeFileSync(file, corpus([['user', `${body('OWNHEAD', 6000)} ${paste} ${body('OWNTAIL', 6000)}`], ['assistant', 'Noted.']]));
    await sweep();
    const all = inputs.join('\n');
    expect(inputs.length).toBeGreaterThan(1);
    expect(all).not.toContain('PASTEMARK');
    expect(all).toContain('OWNHEAD');
    expect(all).toContain('OWNTAIL');
  });

  test('a 20,000-char single assistant turn: every window carries the [assistant] header', async () => {
    const file = join(dir, 'oversized.txt');
    const big = body('ASSTMARK', 20_000);
    writeFileSync(file, corpus([['user', 'Summarize the plan.'], ['assistant', big]]));
    await sweep();
    const chunks = inputs.flatMap((t) => t.split(/\n\n(?=\[(?:user|assistant)\]\n)/)).filter((p) => p.includes('asstmark'));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.startsWith('[assistant]\n')).toBe(true);
    // The extractor trims each window, so compare the words, not the newlines at cuts.
    const words = (t: string) => t.split(/\s+/).filter(Boolean);
    expect(chunks.flatMap((c) => words(c.slice('[assistant]\n'.length)))).toEqual(words(big));
  });

  test('two sweeps racing one file after the hook deleted the claim never extract a window twice', async () => {
    const file = join(dir, 'race.txt');
    writeFileSync(file, corpus(turns(3)));
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inFirstWindow = new Promise<void>((r) => { entered = r; });
    onCall = async (_text, n) => {
      if (n === 1) { entered(); await released; }
    };
    const first = sweep();
    await inFirstWindow;
    rmSync(file + CORPUS_CLAIM_SUFFIX, { force: true }); // the hook's resume path drops claims
    const second = await sweep();
    release();
    const r1 = await first;
    expect(second.skipped).toContainEqual({ reason: 'corpus_in_progress', count: 1 });
    expect(r1.corpusIngested).toBe(1);
    expect(markers(inputs)).toEqual(['T00', 'T01', 'T02']);
  });

  test('an append that lands between two windows is extracted exactly once', async () => {
    const file = join(dir, 'between.txt');
    writeFileSync(file, corpus(turns(3)));
    onCall = (_text, n) => { if (n === 2) hookRewrite(file, corpus(turns(4))); };
    const r1 = await sweep();
    expect(r1.corpusIngested).toBe(0);
    expect(existsSync(file + CORPUS_INGESTED_SUFFIX)).toBe(false);
    onCall = null;
    const r2 = await sweep();
    expect(r2.corpusIngested).toBe(1);
    expect(markers(inputs)).toEqual(['T00', 'T01', 'T02', 'T03']);
  });

  test('the 33rd window across files waits for the next sweep', async () => {
    for (const f of ['a', 'b', 'c', 'd', 'e']) writeFileSync(join(dir, `${f}.txt`), corpus(turns(8)));
    const r1 = await sweep();
    expect(inputs.length).toBe(32);
    expect(r1.skipped).toContainEqual({ reason: 'corpus_window_cap', count: 1 });
    expect(existsSync(join(dir, 'e.txt' + CORPUS_INGESTED_SUFFIX))).toBe(false);
    await sweep();
    expect(inputs.length).toBe(40);
    expect(existsSync(join(dir, 'e.txt' + CORPUS_INGESTED_SUFFIX))).toBe(true);
  });

  test('GBRAIN_CORPUS_WINDOWS_PER_SWEEP=2 extracts two windows in a sweep', async () => {
    writeFileSync(join(dir, 'knob.txt'), corpus(turns(5)));
    await withEnv({ GBRAIN_CORPUS_WINDOWS_PER_SWEEP: '2' }, () => sweep());
    expect(inputs.length).toBe(2);
    expect(markers(inputs)).toEqual(['T00', 'T01']);
  });

  test('a transport failure keeps finished windows; the retry resumes at the failed window', async () => {
    const file = join(dir, 'flaky.txt');
    writeFileSync(file, corpus(turns(3)));
    onCall = (_text, n) => { if (n === 2) throw new Error('fixture transport failure'); };
    const r1 = await sweep();
    expect(r1.corpusIngested).toBe(0);
    expect(existsSync(file + CORPUS_INGESTED_SUFFIX)).toBe(false);
    onCall = null;
    const r2 = await sweep();
    expect(r2.corpusIngested).toBe(1);
    expect(markers(inputs)).toEqual(['T00', 'T01', 'T01', 'T02']);
  });
});

describe('compact harvest extracts window 1 only (#5887)', () => {
  test('a long segment: harvest window 1, a retried harvest re-extracts nothing, one sweep finishes the rest', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-sweep-windows-home-'));
    tmpDirs.push(home);
    await withEnv({ GBRAIN_HOME: home }, async () => {
      const text = corpus(turns(4));
      const w = writeSegment(dir, 'sess-long', text);
      appendSegmentLedger(dir, 'sess-long', w.hash);
      const file = segmentFileName('sess-long', w.hash);
      const full = join(dir, file);
      const job = { engine, sourceId: 'default', sessionId: 'sess-long', corpusDir: dir, file, capabilities: KEYED };

      expect(scheduleCheckpointHarvest(job).status).toBe('scheduled');
      await __drainCheckpointHarvestForTests();
      expect(markers(inputs)).toEqual(['T00']);
      expect(existsSync(full + CORPUS_INGESTED_SUFFIX)).toBe(false);
      expect(existsSync(full + HARVEST_RECEIPT_SUFFIX)).toBe(false);
      expect(JSON.parse(readFileSync(full + '.progress', 'utf8')).windows_done).toBe(1);

      expect(scheduleCheckpointHarvest(job).status).toBe('scheduled');
      await __drainCheckpointHarvestForTests();
      expect(inputs.length).toBe(1);

      const r = await sweep();
      expect(r.corpusIngested).toBe(1);
      expect(markers(inputs)).toEqual(['T00', 'T01', 'T02', 'T03']);
      expect(existsSync(full + CORPUS_INGESTED_SUFFIX)).toBe(true);
    });
  });
});
