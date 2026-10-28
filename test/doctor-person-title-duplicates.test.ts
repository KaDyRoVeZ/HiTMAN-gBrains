/**
 * person_title_duplicates doctor check (#7160): title-prefixed person pages
 * next to the unprefixed page of the same person, reported and never merged.
 * PGLite in-memory, synthetic names.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { personTitleDuplicatesEntry } from '../src/commands/doctor/checks/entity-duplicates.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

const person = (slug: string, title: string) => engine.putPage(slug, { title, type: 'person', compiled_truth: `${title}.` } as never);

beforeEach(async () => {
  await resetPgliteState(engine);
  await person('people/robert-thistlewood', 'Robert Thistlewood');
  await person('people/alice-example', 'Alice Example');
  await person('people/bob-sample', 'Bob Sample');
  await person('people/carol-sample', 'Carol Sample');
});

async function check() {
  const ctx = { engine, orphanRatioSourceId: undefined, progress: { heartbeat() {} } } as unknown as DoctorContext;
  const [c] = await personTitleDuplicatesEntry.run(ctx) as Array<{ name: string; status: string; message: string; details: any; fix?: any }>;
  return c!;
}

describe('person_title_duplicates', () => {
  test('a hyphenated surname pairs too, in both title styles', async () => {
    await person('people/ada-quill-example', 'Ada Quill-Example');
    await person('people/mayor-quill-example', 'Mayor Quill-Example');
    await person('people/ceo-fen-example', 'CEO Fen-Example');
    await person('people/cy-fen-example', 'Cy Fen-Example');
    const c = await check();
    expect(c.details.pairs.map((p: any) => [p.stub, p.canonical])).toEqual([
      ['people/ceo-fen-example', 'people/cy-fen-example'],
      ['people/mayor-quill-example', 'people/ada-quill-example'],
    ]);
  });

  test('ok when no titled person page exists', async () => {
    const c = await check();
    expect(c).toMatchObject({ name: 'person_title_duplicates', status: 'ok' });
  });

  test('pairs a titled stub with the one person its remaining name resolves to, without changing anything', async () => {
    await person('people/mayor-thistlewood', 'Mayor Thistlewood');
    await person('people/dr-alice-example', 'Dr. Alice Example');
    const c = await check();
    expect(c.status).toBe('warn');
    expect(c.details.pairs.map((p: any) => [p.stub, p.canonical])).toEqual([
      ['people/dr-alice-example', 'people/alice-example'],
      ['people/mayor-thistlewood', 'people/robert-thistlewood'],
    ]);
    expect(c.fix.ask_user).toBe(true);
    expect(c.fix.user_message).toContain('merged_into:');
    const [still] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE slug = 'people/mayor-thistlewood' AND deleted_at IS NULL");
    expect(still!.n).toBe(1);
  });

  test('a surname two people share pairs with nobody', async () => {
    await person('people/mayor-sample', 'Mayor Sample');
    const c = await check();
    expect(c.status).toBe('ok');
  });

  test('a stub the owner already marked merged_into is settled and not listed', async () => {
    await engine.putPage('people/mayor-thistlewood', { title: 'Mayor Thistlewood', type: 'person', compiled_truth: 'x', frontmatter: { merged_into: 'people/robert-thistlewood' } } as never);
    const c = await check();
    expect(c.status).toBe('ok');
  });

  test('is categorized', () => {
    expect(categorizeCheck('person_title_duplicates')).toBeTruthy();
  });
});
