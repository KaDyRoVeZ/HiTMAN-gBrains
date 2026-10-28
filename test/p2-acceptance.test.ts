/**
 * Ranking and extraction settings, end to end on one keyless brain.
 *
 * Protects: on a populated brain with every new setting turned on
 * (extraction.date_grounding, facts.attribution),
 * re-running schema setup, the doctor check and an explained search
 * makes zero model calls; explain returns score_details whose final equals
 * the row score; explain_target diagnoses a page the source filter removed
 * without returning it.
 * Seams: in-memory PGLite; the chat and embedding transports are replaced
 * by counters that fail the test if anything calls them.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { __setChatTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { extractionDateGroundingEntry } from '../src/commands/doctor/checks/ranking-extraction.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
let modelCalls = 0;
const metas: Record<string, unknown>[] = [];
const ctx = () => ({
  engine, remote: false, sourceId: 'default', config: { engine: 'pglite', embedding_disabled: true }, dryRun: false,
  logger: { info() {}, warn() {}, error() {} },
  emitNotice: () => {},
  emitResponseMeta: (key: string, value: unknown) => { if (key === 'retrieval') metas.push(value as Record<string, unknown>); },
}) as unknown as OperationContext;

beforeAll(async () => {
  __setChatTransportForTests(async () => { modelCalls++; throw new Error('no model call expected'); });
  __setEmbedTransportForTests((async () => { modelCalls++; throw new Error('no model call expected'); }) as never);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  __resetPrivateVisibilityCacheForTests();
  await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme', compiled_truth: 'Acme builds quokka trackers.' });
  const links = [];
  for (let i = 0; i < 8; i++) {
    await importFromContent(engine, `meetings/m-${i}`, `---\ntype: meeting\ndate: "2024-03-0${i + 1}"\n---\n# Sync ${i}\nQuokka tracker sync with acme.`, { noEmbed: true });
    links.push({ from_slug: `meetings/m-${i}`, to_slug: 'companies/acme-example', link_type: 'mentions_company' });
  }
  await engine.addLinksBatch(links);
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('team', 'team') ON CONFLICT DO NOTHING`);
  await importFromContent(engine, 'notes/quokka-team', '# Team quokka\nQuokka tracker notes for the team.', { noEmbed: true, sourceId: 'team' });
  for (const [k, v] of [['extraction.date_grounding', 'true'], ['facts.attribution', 'true']]) await engine.setConfig(k, v);
}, 120_000);

afterAll(async () => {
  __setChatTransportForTests(null);
  __setEmbedTransportForTests(null as never);
  if (engine) await engine.disconnect();
});

describe('ranking and extraction settings on a populated keyless brain', () => {
  test('schema setup again and the date-grounding doctor check make no model calls and stay informational', async () => {
    await engine.initSchema();
    const dctx = { engine, args: [], progress: { heartbeat() {} } } as unknown as DoctorContext;
    const checks = (await extractionDateGroundingEntry.run(dctx)) as Check[];
    expect(checks.map(c => c.status)).toEqual(['ok']);
    expect(checks[0].message).toMatch(/on/i);
    expect(modelCalls).toBe(0);
  });

  test('explain: score_details final equals the row score', async () => {
    const rows = await operationsByName.query.handler(ctx(), { query: 'quokka tracker', expand: false, explain: true }) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect((r.score_details as { final: number }).final).toBe(r.score as number);
    expect(modelCalls).toBe(0);
  });

  test('explain_target: a page outside the requested source is diagnosed, never returned', async () => {
    metas.length = 0;
    const rows = await operationsByName.query.handler(ctx(), { query: 'quokka tracker', expand: false, source_id: 'default', explain_target: 'team:notes/quokka-team' }) as Array<{ slug: string }>;
    expect(rows.some(r => r.slug === 'notes/quokka-team')).toBe(false);
    const diag = metas.at(-1)?.explain_target as { state: string; code: string } | undefined;
    expect(diag).toMatchObject({ state: 'not_retrieved', code: 'target_not_found_or_not_visible' });
    expect(modelCalls).toBe(0);
  });
});
