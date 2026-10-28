/**
 * extraction_date_grounding doctor check.
 *
 * Protects: the check names the setting and its consumers, and stays
 * informational (ok).
 * Seams: none; in-memory PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractionDateGroundingEntry } from '../src/commands/doctor/checks/ranking-extraction.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
const ctx = () => ({ engine, args: [], progress: { heartbeat() {} } }) as unknown as DoctorContext;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { if (engine) await engine.disconnect(); });

describe('extraction_date_grounding', () => {
  test('fact extraction is grounded by default; the other prompts only when set on; false turns it off', async () => {
    const [byDefault] = (await extractionDateGroundingEntry.run(ctx())) as Check[];
    expect(byDefault.message).toContain('fact extraction, dream synthesis, extract_atoms and propose_takes (the default)');
    expect(byDefault.message).toContain('life chronicle events keep their current prompt unless extraction.date_grounding is set to true');
    await engine.setConfig('extraction.date_grounding', 'true');
    const [on] = (await extractionDateGroundingEntry.run(ctx())) as Check[];
    expect(on.message).toContain('and in life chronicle events (set on explicitly)');
    await engine.setConfig('extraction.date_grounding', 'false');
    const [off] = (await extractionDateGroundingEntry.run(ctx())) as Check[];
    expect(off.message).toContain('is off');
    expect(categorizeCheck('extraction_date_grounding')).toBe(categorizeCheck('graph_coverage'));
  });
});
