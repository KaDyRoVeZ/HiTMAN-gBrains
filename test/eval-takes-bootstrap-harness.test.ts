/**
 * Keyless check that the takes-bootstrap eval harness reaches the classifier
 * and durably writes takes through the production path (TODO-E instrument).
 *
 * Protects: a corpus case seeded by evals/takes-bootstrap/run-case.ts is
 * selected by extractTakesFromPages, classified, and its take lands in the
 * page's markdown fence AND the takes table, and the case scores from that
 * fence. Regressions it catches: a corpus page the production selector
 * rejects (type outside ALLOWED_PAGE_TYPES, body of 200 chars or less), a
 * missing markdown destination (`mirror_unavailable` skip), predictions read
 * from somewhere the extractor never wrote. Existing coverage scores saved
 * predictions only (test/eval-takes-bootstrap.test.ts) and never runs a case.
 * Seam: the gateway's chat transport stub, which production never sets.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, type ChatOpts } from '../src/core/ai/gateway.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runCase, EVAL_HOLDER } from '../evals/takes-bootstrap/run-case.ts';
import { scoreCorpus, type CorpusCase } from '../evals/takes-bootstrap/scorer.ts';

const MODEL = 'anthropic:claude-haiku-4-5';
const corpus: CorpusCase[] = readFileSync(join(import.meta.dir, '..', 'evals/takes-bootstrap/corpus.jsonl'), 'utf8')
  .trim().split('\n').map(l => JSON.parse(l));
const takeCase = corpus.find(c => c.id === 'take-plain-v1')!;

let engine: PGLiteEngine;
let brainDir: string;
let classified: string[] = [];

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  brainDir = mkdtempSync(join(tmpdir(), 'takes-eval-harness-'));
  configureGateway({ chat_model: MODEL, env: { ANTHROPIC_API_KEY: 'sk-ant-test-takes-eval' } });
  __setChatTransportForTests(async (opts: ChatOpts) => {
    const user = opts.messages.find(m => m.role === 'user');
    classified.push(typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content));
    const text = '[{"claim":"Acme Example is the strongest team in the batch","kind":"take","weight":0.8}]';
    return {
      text,
      blocks: [{ type: 'text' as const, text }],
      stopReason: 'end' as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: MODEL,
      providerId: 'anthropic',
    };
  });
});

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  classified = [];
  await engine.setConfig('sync.repo_path', brainDir);
});

describe('takes-bootstrap harness case run', () => {
  test('a corpus case is classified and its take is written to the fence and the takes table', async () => {
    const run = await runCase(engine, brainDir, takeCase, MODEL);

    expect(classified).toHaveLength(1);
    expect(classified[0]).toContain(`<page slug="${takeCase.page.slug}"`);
    expect(classified[0]).toContain('strongest team in the batch');

    const fence = parseTakesFence(readFileSync(join(brainDir, `${takeCase.page.slug}.md`), 'utf8'));
    expect(fence.takes.map(t => [t.claim, t.kind, t.holder])).toEqual([
      ['Acme Example is the strongest team in the batch', 'take', EVAL_HOLDER],
    ]);
    const rows = await engine.executeRaw<{ claim: string; kind: string; holder: string }>(
      `SELECT t.claim, t.kind, t.holder FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1`,
      [takeCase.page.slug],
    );
    expect(rows.map(r => [r.claim, r.kind, r.holder])).toEqual([
      ['Acme Example is the strongest team in the batch', 'take', EVAL_HOLDER],
    ]);

    expect(run).toEqual({ id: takeCase.id, claims: [{ claim: 'Acme Example is the strongest team in the batch', kind: 'take', weight: 0.8 }] });
    const report = scoreCorpus([takeCase], [run]);
    expect(report.by_variant[0]).toMatchObject({ id: takeCase.id, matched: 1, precise: 1, pass: true });
    expect(report.graduated).toBe(true);
  });
});
