/**
 * #5831: atom pages are no longer a facts-backstop source. Doctor's
 * facts_health names how many active facts earlier extraction derived from
 * atom pages, so an operator can see what the change leaves behind.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { queueHealthEntry } from '../src/commands/doctor/checks/queue-assets.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

const factsHealth = async () => {
  const ctx = { engine, progress: { heartbeat() {} }, args: [] } as unknown as DoctorContext;
  return (await queueHealthEntry.run(ctx) as Array<{ name: string; message: string }>).find(c => c.name === 'facts_health')!;
};

describe('facts_health reports atom-derived facts (#5831)', () => {
  test('silent when no atom page fed facts, counts them when one did', async () => {
    await engine.putPage('notes/plain-example', { type: 'note', title: 'Plain', compiled_truth: 'Plain note.' }, { sourceId: 'default' });
    await engine.putPage('atoms/2026-10-01/lesson-example', { type: 'atom', title: 'Lesson', compiled_truth: 'Small teams ship faster.' }, { sourceId: 'default' });
    await engine.insertFact({ fact: 'a note fact', kind: 'fact', entity_slug: 'acme-example', source: 'test', context: 'notes/plain-example' }, { source_id: 'default' });
    expect((await factsHealth()).message).not.toContain('atom pages');
    await engine.insertFact({ fact: 'small teams ship faster', kind: 'fact', entity_slug: null, source: 'test', context: 'atoms/2026-10-01/lesson-example' }, { source_id: 'default' });
    await engine.insertFact({ fact: 'written decisions help', kind: 'fact', entity_slug: null, source: 'test', context: 'atoms/2026-10-01/lesson-example' }, { source_id: 'default' });
    expect((await factsHealth()).message).toContain('2 active fact(s) came from atom pages, which are no longer extracted');
  });
});
