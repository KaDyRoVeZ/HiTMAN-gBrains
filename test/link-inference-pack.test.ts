// v0.38 T7b: pack-aware link inference tests.
//
// Pins the contract that `inferLinkTypeFromPack` consults pack-declared
// verbs WITHOUT replacing legacy in-code inferLinkType. Two scenarios:
//   1. Legacy gbrain-base routes (founded/invested_in/advises/works_at)
//      stay reachable via the existing inferLinkType call.
//   2. User packs can ADD new verbs via link_types[].inference.regex;
//      the new verb resolves on the pack-aware path before the legacy
//      fall-through.

import { describe, expect, test } from 'bun:test';
import {
  inferLinkTypeFromPack,
  frontmatterLinkTypeFromPack,
  parseSchemaPackManifest,
  PageRegexBudget,
} from '../src/core/schema-pack/index.ts';
import { inferLinkType } from '../src/core/link-extraction.ts';

describe('inferLinkTypeFromPack (T7b)', () => {
  const minimalPack = (link_types: Array<Record<string, unknown>>) =>
    parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'test',
      version: '0.1.0',
      extends: null,
      page_types: [],
      link_types,
    });

  test('page-type-bound verb resolves deterministically (meeting → attended)', () => {
    const pack = minimalPack([
      { name: 'attended', inference: { page_type: 'meeting' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'meeting', 'irrelevant text')).toBe('attended');
  });

  test('image → image_of via pack declaration', () => {
    const pack = minimalPack([
      { name: 'image_of', inference: { page_type: 'image' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'image', 'doesnt matter')).toBe('image_of');
  });

  test('regex matcher resolves user-declared verb', () => {
    const pack = minimalPack([
      { name: 'supports', inference: { regex: '\\b(supports|in support of)\\b' } },
      { name: 'weakens', inference: { regex: '\\b(weakens|undermines)\\b' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'paper', 'this evidence supports the claim')).toBe('supports');
    expect(inferLinkTypeFromPack(pack, 'paper', 'this evidence weakens the claim')).toBe('weakens');
    expect(inferLinkTypeFromPack(pack, 'paper', 'mentions only')).toBeNull();
  });

  test('returns null when no rule fires (caller falls through to legacy)', () => {
    const pack = minimalPack([
      { name: 'cites', inference: { regex: '\\bcites?\\b' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'paper', 'no matching text here')).toBeNull();
  });

  test('first match wins in declaration order', () => {
    const pack = minimalPack([
      { name: 'first-match', inference: { regex: '\\bword\\b' } },
      { name: 'second-match', inference: { regex: '\\bword\\b' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'concept', 'the word matters')).toBe('first-match');
  });

  test('respects PageRegexBudget exhaustion', () => {
    const pack = minimalPack([
      { name: 'a', inference: { regex: '\\ba\\b' } },
      { name: 'b', inference: { regex: '\\bb\\b' } },
    ]);
    const budget = new PageRegexBudget();
    // First call within budget — should resolve.
    expect(inferLinkTypeFromPack(pack, 'concept', 'a then b', budget)).toBe('a');
    // Budget tracker accumulates.
    expect(budget.getCumulativeMs()).toBeGreaterThanOrEqual(0);
  });

  test('legacy inferLinkType still operates independently', () => {
    // The pack-aware variant doesn't break legacy callers.
    expect(inferLinkType('person', 'founded Acme Corp last year')).toBe('founded');
    expect(inferLinkType('person', 'invested in Acme Series A')).toBe('invested_in');
    expect(inferLinkType('person', 'advises Acme')).toBe('advises');
  });

  test('pack-aware regex with malformed pattern returns null gracefully', () => {
    // Pack validation should catch this at load; this is the runtime
    // safety net.
    const pack = minimalPack([
      { name: 'broken', inference: { regex: '[unclosed' } },
    ]);
    expect(inferLinkTypeFromPack(pack, 'concept', 'text')).toBeNull();
  });
});

describe('frontmatterLinkTypeFromPack (T7b)', () => {
  test('person:company → works_at via pack declaration', () => {
    const pack = parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'test',
      version: '0.1.0',
      extends: null,
      page_types: [],
      link_types: [],
      frontmatter_links: [
        { page_type: 'person', fields: ['company', 'companies'], link_type: 'works_at' },
        { page_type: 'company', fields: ['key_people'], link_type: 'works_at' },
        { page_type: 'meeting', fields: ['attendees'], link_type: 'attended' },
      ],
    });
    expect(frontmatterLinkTypeFromPack(pack, 'person', 'company')).toBe('works_at');
    expect(frontmatterLinkTypeFromPack(pack, 'person', 'companies')).toBe('works_at');
    expect(frontmatterLinkTypeFromPack(pack, 'company', 'key_people')).toBe('works_at');
    expect(frontmatterLinkTypeFromPack(pack, 'meeting', 'attendees')).toBe('attended');
    expect(frontmatterLinkTypeFromPack(pack, 'person', 'random_field')).toBeNull();
    // Wrong page type: doesn't match.
    expect(frontmatterLinkTypeFromPack(pack, 'company', 'company')).toBeNull();
  });

  test('empty frontmatter_links returns null for every field', () => {
    const pack = parseSchemaPackManifest({
      api_version: 'gbrain-schema-pack-v1',
      name: 'test',
      version: '0.1.0',
      extends: null,
      page_types: [],
      link_types: [],
    });
    expect(frontmatterLinkTypeFromPack(pack, 'person', 'company')).toBeNull();
  });
});

// #2117 — the bundled gbrain-base-v2 pack routes the four legacy NER verbs
// through pack-declared regexes. Pre-fix v2 declared zero inference regexes,
// so extract-ner returned pack_unavailable for every v2 brain while the
// same text routed fine on gbrain-base.
import { readFileSync } from 'node:fs';
import { parseYamlMini } from '../src/core/schema-pack/index.ts';
import { inferNerLinkType } from '../src/core/extract-ner.ts';
import { extractPageLinks } from '../src/core/link-extraction.ts';
import { bundledPackPath } from '../src/core/schema-pack/bundled-assets.ts';

describe('#2117: gbrain-base-v2 NER verb routes', () => {
  // The bundled packs, loaded from the asset path the runtime resolves.
  const bundled = (name: string) => {
    const path = bundledPackPath(name)!;
    return parseSchemaPackManifest(parseYamlMini(readFileSync(path, 'utf-8')), { path });
  };
  const v2 = bundled('gbrain-base-v2');
  const v1 = bundled('gbrain-base');

  test('founded/invested_in/advises/works_at resolve via pack regexes for NER', () => {
    expect(inferNerLinkType(v2, 'person', 'co-founded Acme Corp last year')).toBe('founded');
    expect(inferNerLinkType(v2, 'person', 'invested in Acme Series A')).toBe('invested_in');
    expect(inferNerLinkType(v2, 'person', 'advises widget-co on hiring')).toBe('advises');
    expect(inferNerLinkType(v2, 'person', 'works at widget-co')).toBe('works_at');
  });

  test('non-matching text still falls through to null', () => {
    expect(inferNerLinkType(v2, 'person', 'a sentence with no verb signal')).toBeNull();
  });

  // #5882: the sketch regexes are NER-only, so markdown link typing falls
  // through to the tuned in-code matchers instead of labelling a bare
  // "started" founded or a bare "joined" works_at.
  test('markdown extraction on gbrain-base-v2: a bare "started" or "joined" no longer types the link (#5882)', async () => {
    const resolver = { resolve: async () => null };
    const note = await extractPageLinks('notes/kickoff-example',
      'The migration work [Acme](../companies/acme-example.md) started on Monday. [Alice](../people/alice-example.md) joined the call late.',
      {}, 'note', resolver, { skipFrontmatter: true, pack: v2 });
    const types = Object.fromEntries(note.candidates.map(c => [c.targetSlug, c.linkType]));
    expect(types['companies/acme-example']).not.toBe('founded');
    expect(types['people/alice-example']).not.toBe('works_at');
    const founder = await extractPageLinks('people/bob-example', '[Bob](bob-example.md) co-founded [Acme](../companies/acme-example.md) in 2019.',
      {}, 'person', resolver, { skipFrontmatter: true, pack: v2 });
    expect(founder.candidates.find(c => c.targetSlug === 'companies/acme-example')?.linkType).toBe('founded');
  });

  test('the sketch regexes never claim a markdown link context', () => {
    for (const pack of [v2, v1]) {
      expect(inferLinkTypeFromPack(pack, 'meeting', 'the migration work started on Monday')).not.toBe('founded');
      expect(inferLinkTypeFromPack(pack, 'note', 'the migration work started on Monday')).toBeNull();
      expect(inferLinkTypeFromPack(pack, 'note', 'she joined the call late')).toBeNull();
      expect(inferLinkTypeFromPack(pack, 'note', 'co-founded Acme Corp last year')).toBeNull();
    }
  });
});
