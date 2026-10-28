/**
 * #7161: names that only appear in page text (entity miss) and thin stub
 * cards while mention coverage is incomplete. Synthetic names only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { buildEntityCard } from '../src/core/verbs/entity-card.ts';
import { seedPage } from './helpers/keyword-paging-fixture.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

const note = (slug: string, body: string, frontmatter: Record<string, unknown> = {}) =>
  seedPage(engine, slug, body, { title: slug.split('/').pop()!, frontmatter: { date: slug.split('/').pop(), ...frontmatter } });

beforeEach(async () => {
  await resetPgliteState(engine);
  await note('notes/2026-03-01', 'Coffee with Imogen Farthingale about the pilot.');
  await note('notes/2026-04-02', 'Imogen Farthingale sent the revised budget.');
  await note('notes/2026-05-03', 'Unrelated: Imogen met Farthingale Partners.');
  await note('notes/2026-06-04', 'Private: Imogen Farthingale salary talk.', { visibility: 'private' });
});

const card = (name: string, remote = false) => buildEntityCard(engine, 'default', name, { remote, includeReferences: true, omitQuarantined: remote, variants: true });

describe('a name with no page', () => {
  test('a miss lists the pages whose text contains the name, newest first', async () => {
    const res = await card('Imogen Farthingale');
    expect(res.found).toBe(false);
    expect(res.text_mentions!.pages.map(p => p.slug)).toEqual(['notes/2026-06-04', 'notes/2026-04-02', 'notes/2026-03-01']);
    expect(res.text_mentions!.total).toBe(3);
    expect(res.text_mentions!.capped).toBe(false);
  });

  test('a page with both words but not the name is not listed', async () => {
    const res = await card('Imogen Farthingale');
    expect(res.text_mentions!.pages.map(p => p.slug)).not.toContain('notes/2026-05-03');
  });

  test('a remote caller never sees a private page', async () => {
    const res = await card('Imogen Farthingale', true);
    expect(res.text_mentions!.pages.map(p => p.slug)).toEqual(['notes/2026-04-02', 'notes/2026-03-01']);
  });

  test('a hyphenated surname is found as written', async () => {
    await note('notes/2026-07-01', 'Coffee with Bea Marsh-Example and Cy Fen-Example about the harbor grant.');
    const res = await card('Bea Marsh-Example');
    expect(res.text_mentions!.pages.map(p => p.slug)).toEqual(['notes/2026-07-01']);
  });

  test('a name nobody wrote has no text_mentions', async () => {
    const res = await card('Quentin Nobody');
    expect(res.found).toBe(false);
    expect(res.text_mentions).toBeUndefined();
  });
});

describe('a thin stub card while mentions are behind', () => {
  test('lists the newer text mentions next to the stub', async () => {
    await seedPage(engine, 'people/orla-vantage', 'Speaker.', { type: 'person', title: 'Orla Vantage' });
    await note('notes/2026-07-05', 'Orla Vantage announced a new fund today.');
    const res = await card('Orla Vantage');
    expect(res.card!.entity.slug).toBe('people/orla-vantage');
    expect(res.card!.coverage?.state).not.toBe('complete');
    expect(res.card!.text_mentions!.pages.map(p => p.slug)).toEqual(['notes/2026-07-05']);
  });
});
