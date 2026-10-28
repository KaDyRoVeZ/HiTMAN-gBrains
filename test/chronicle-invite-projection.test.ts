/**
 * Life Chronicle ended-invite projection (invite-projection.ts).
 *
 * Protects: an ended calendar invite becomes one `Scheduled: <title>` meeting
 * event with no chat call, no daily reservation and a zero-cost extracted
 * ledger row, through the same publication and ownership rules as a judged
 * page; an invite that has not ended waits as before; a calendar page that
 * is not a structured invite is still judged.
 * Fails when: an ended invite reaches the judge, the event reads as attended
 * (no scheduled label), a re-run rewrites or duplicates the event, or a
 * re-projection overwrites an operator's edit.
 * Existing coverage: chronicle-auto-phase pins when an invite becomes
 * eligible, not how it is extracted.
 * Seams: injected judge (`runPhaseChronicle({ judge })`), which must stay uncalled.
 */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { runPhaseChronicle } from '../src/core/cycle/chronicle.ts';
import { runChronicleBackfill } from '../src/core/chronicle/backfill.ts';
import type { ChronicleJudge } from '../src/core/chronicle/extract-events.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase } from './helpers/test-backends.ts';

const databaseUrl = process.env.GBRAIN_TEST_BACKEND === 'postgres' ? requirePostgresTestDatabase() : undefined;
const brain = (run: (b: ManagedBrain) => Promise<void>) => managedBrain(run, { databaseUrl });

const hourAgo = () => new Date(Date.now() - 3_600_000);
const invite = (opts: { start: Date; end: Date; location?: string }) => [
  '---', 'type: meeting', 'title: Weekly sync with alice-example', 'event_id: "evt-1"',
  `start: "${opts.start.toISOString()}"`, `end: "${opts.end.toISOString()}"`, 'all_day: false',
  'attendees: ["alice@example.com", "bob@example.com"]', ...(opts.location ? [`location: "${opts.location}"`] : []), '---', '',
  '# Weekly sync with alice-example', '', 'Agenda: review the beta launch checklist and assign the remaining owners for each item.', '',
].join('\n');

async function put(ctx: OperationContext, slug: string, content: string) {
  const current = await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' });
  return await operationsByName.put_page.handler(ctx, { slug, content, ...(current ? { expected_revision: current.revision } : {}) }) as Record<string, unknown>;
}
async function settle(engine: BrainEngine) {
  await engine.executeRaw("UPDATE chronicle_page_state SET next_attempt_at=now()-interval '1 second', decided_at=now()-interval '1 hour' WHERE state='pending'");
}
function noJudge() {
  const judge = Object.assign((async () => { judge.calls++; return { events: [] }; }) as ChronicleJudge, { calls: 0 });
  return judge;
}
async function run(engine: BrainEngine, judge: ChronicleJudge) {
  await settle(engine);
  return (await runPhaseChronicle(engine, { judge })).details;
}
async function events(engine: BrainEngine) {
  return engine.executeRaw<{ slug: string; title: string; what: string; kind: string; where: string | null; who: string;
    captured_via: string; content_hash: string; deleted: boolean }>(
    `SELECT slug, title, frontmatter->'event'->>'what' AS what, frontmatter->'event'->>'kind' AS kind,
            frontmatter->'event'->>'where' AS "where", frontmatter->'event'->>'who' AS who,
            frontmatter->>'captured_via' AS captured_via, content_hash, deleted_at IS NOT NULL AS deleted
       FROM pages WHERE type='event' ORDER BY slug`);
}
const reservations = async (engine: BrainEngine) =>
  (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM chronicle_judge_reservations'))[0].n;

test('an ended invite projects to one scheduled meeting event with no chat call', () => brain(async ({ engine, ctx }) => {
  const start = new Date(Date.now() - 2 * 3_600_000);
  await put(ctx, 'calendar/2026/10/weekly-sync', invite({ start, end: hourAgo(), location: 'Room 4' }));
  const judge = noJudge();
  const details = await run(engine, judge);
  expect(judge.calls).toBe(0);
  expect(await reservations(engine)).toBe(0);
  expect(details).toMatchObject({ judged: 0, extracted: 1, events_written: 1, spent_usd: 0 });
  const [event] = await events(engine);
  expect(event).toMatchObject({ title: 'Scheduled: Weekly sync with alice-example', what: 'Scheduled: Weekly sync with alice-example',
    kind: 'meeting', where: 'Room 4', captured_via: 'life-chronicle:invite', deleted: false });
  expect(JSON.parse(event.who)).toEqual(['alice@example.com', 'bob@example.com']);
  const [row] = await engine.executeRaw<{ state: string; reason: string | null; cost_usd: string | null; event_slugs: string[] }>(
    'SELECT state, reason, cost_usd::text, event_slugs FROM chronicle_page_state');
  expect(row).toMatchObject({ state: 'extracted', reason: null, event_slugs: [event.slug] });
  expect(Number(row.cost_usd)).toBe(0);
  const day = start.toISOString().slice(0, 10);
  expect((await engine.getTimelineForDate(day, {})).map((r) => r.summary)).toContain('Scheduled: Weekly sync with alice-example');
}), 120_000);

test('an invite that has not ended waits and is not projected', () => brain(async ({ engine, ctx }) => {
  const receipt = await put(ctx, 'calendar/2026/10/next-sync', invite({ start: new Date(Date.now() + 3_600_000), end: new Date(Date.now() + 7_200_000) }));
  expect(receipt.chronicle_backstop).toMatchObject({ skipped: 'not_yet_happened' });
  const judge = noJudge();
  await run(engine, judge);
  expect(judge.calls).toBe(0);
  expect(await events(engine)).toEqual([]);
}), 120_000);

test('re-runs and a forced reprocess leave the projected event as it is', () => brain(async ({ engine, ctx }) => {
  await put(ctx, 'calendar/2026/10/weekly-sync', invite({ start: new Date(Date.now() - 2 * 3_600_000), end: hourAgo() }));
  const judge = noJudge();
  await run(engine, judge);
  const first = await events(engine);
  expect((await run(engine, judge))).toMatchObject({ candidates: 0, events_written: 0 });
  await engine.executeRaw('UPDATE chronicle_page_state SET extractor_version=1');
  expect(await runChronicleBackfill(engine, { yes: true })).toMatchObject({ queued: 1 });
  expect(await run(engine, judge)).toMatchObject({ extracted: 1, events_retired: 0 });
  expect(judge.calls).toBe(0);
  expect(await events(engine)).toEqual(first);
}), 120_000);

test('a re-projection never overwrites an operator-edited event', () => brain(async ({ engine, ctx }) => {
  const start = new Date(Date.now() - 2 * 3_600_000);
  await put(ctx, 'calendar/2026/10/weekly-sync', invite({ start, end: hourAgo() }));
  const judge = noJudge();
  await run(engine, judge);
  const [event] = await events(engine);
  const page = (await engine.readPageSnapshot(event.slug, { sourceId: 'default' }))!;
  const { serializePageToMarkdown } = await import('../src/core/markdown.ts');
  await operationsByName.put_page.handler(ctx, { slug: event.slug, expected_revision: page.revision,
    content: serializePageToMarkdown({ ...page.page, compiled_truth: 'Weekly sync with alice-example: attended, notes in meetings/.' }, page.tags) });
  const [edited] = await events(engine);
  await put(ctx, 'calendar/2026/10/weekly-sync', invite({ start, end: hourAgo(), location: 'Room 9' }));
  await run(engine, judge);
  expect(judge.calls).toBe(0);
  expect(await events(engine)).toEqual([edited]);
}), 120_000);

test('a calendar page without start and end is still judged', () => brain(async ({ engine, ctx }) => {
  const today = new Date().toISOString().slice(0, 10);
  await put(ctx, 'calendar/2026/10/notes', `---\ntype: meeting\ntitle: Offsite notes\ndate: ${today}\n---\n\n${'Alice and Bob walked through the offsite plan and agreed on owners. '.repeat(3)}`);
  const judge = noJudge();
  await run(engine, judge);
  expect(judge.calls).toBe(1);
}), 120_000);
