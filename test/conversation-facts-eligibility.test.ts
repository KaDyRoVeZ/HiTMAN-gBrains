/**
 * #5330: conversation-facts eligibility is one shared rule. A source-evidence
 * page that shares a conversation type but holds no conversation is marked
 * `conversation_parseable: false`; the extractor skips it and the doctor
 * backlog stops counting it, so the backlog can drain. Strict mode
 * (`cycle.conversation_facts_backfill.require_parseable_flag`) admits only
 * `type: conversation` or an explicit `conversation_parseable: true`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { computeConversationFactsBacklogCheck } from '../src/commands/doctor.ts';
import { runExtractConversationFactsCore } from '../src/commands/extract-conversation-facts.ts';
import {
  REQUIRE_PARSEABLE_FLAG_CONFIG_KEY,
  conversationFactsEligibleSql,
  isConversationFactsEligiblePage,
  pageTypesForAllowed,
} from '../src/core/facts/conversation-types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
});

const TRANSCRIPT = '**Alice** (2024-03-15 9:00 AM): hello\n**Bob** (2024-03-15 9:01 AM): hi';

async function seed(slug: string, type: string, frontmatter: Record<string, unknown>, body = TRANSCRIPT): Promise<void> {
  await engine.putPage(slug, { type, title: slug, compiled_truth: body, timeline: '', frontmatter });
}

describe('isConversationFactsEligiblePage', () => {
  const types = pageTypesForAllowed(['conversation', 'email']);
  test('allowed type, unless marked not parseable', () => {
    expect(isConversationFactsEligiblePage({ type: 'email', frontmatter: {} }, types)).toBe(true);
    expect(isConversationFactsEligiblePage({ type: 'email-digest', frontmatter: {} }, types)).toBe(true);
    expect(isConversationFactsEligiblePage({ type: 'note', frontmatter: {} }, types)).toBe(false);
    for (const marker of [false, 'false', 'no', 0, 'OFF']) {
      expect(isConversationFactsEligiblePage({ type: 'email', frontmatter: { conversation_parseable: marker } }, types)).toBe(false);
    }
  });
  test('strict mode admits conversation pages and explicit markers only', () => {
    expect(isConversationFactsEligiblePage({ type: 'email', frontmatter: {} }, types, true)).toBe(false);
    expect(isConversationFactsEligiblePage({ type: 'email', frontmatter: { conversation_parseable: true } }, types, true)).toBe(true);
    expect(isConversationFactsEligiblePage({ type: 'conversation', frontmatter: {} }, types, true)).toBe(true);
    expect(isConversationFactsEligiblePage({ type: 'conversation', frontmatter: { conversation_parseable: 'false' } }, types, true)).toBe(false);
  });
  test('the SQL twin selects exactly the pages the predicate admits', async () => {
    const pages: Array<[string, string, Record<string, unknown>]> = [
      ['email/a', 'email', {}],
      ['email/b', 'email', { conversation_parseable: false }],
      ['email/c', 'email', { conversation_parseable: 'true' }],
      ['email/d', 'email-digest', { conversation_parseable: 'no' }],
      ['conversations/e', 'conversation', {}],
      ['notes/f', 'note', {}],
    ];
    for (const [slug, type, fm] of pages) await seed(slug, type, fm);
    for (const strict of [false, true]) {
      const rows = await engine.executeRaw<{ slug: string }>(
        `SELECT slug FROM pages p WHERE ${conversationFactsEligibleSql('p', '$1', strict)} ORDER BY slug`, [types]);
      const expected = pages.filter(([, type, fm]) => isConversationFactsEligiblePage({ type, frontmatter: fm }, types, strict)).map(([slug]) => slug).sort();
      expect(rows.map(r => r.slug)).toEqual(expected);
    }
  });
});

describe('#5330 the backlog drains', () => {
  test('a source-evidence page marked not parseable is neither claimed nor counted', async () => {
    await seed('email/threads/parseable', 'email', {});
    await seed('email/messages/source-evidence', 'email', { conversation_parseable: false }, '# Message record\n\nnot a transcript');

    expect((await computeConversationFactsBacklogCheck(engine)).details?.backlog).toBe(1);

    const claimed: string[] = [];
    const result = await runExtractConversationFactsCore(engine, {
      sourceId: 'default', types: ['email'], sleepMs: 0,
      extractor: async input => { claimed.push(input.turnText); return []; },
    });
    expect(result.pages_skipped).toBeGreaterThanOrEqual(1);
    expect(claimed.every(t => !t.includes('Message record'))).toBe(true);
    expect((await computeConversationFactsBacklogCheck(engine)).details?.backlog).toBe(0);

    const single = await runExtractConversationFactsCore(engine, { sourceId: 'default', slug: 'email/messages/source-evidence', sleepMs: 0 });
    expect(single.pages_skipped_type_mismatch).toBe(1);
    expect(single.pages_processed).toBe(0);
  });

  test('strict mode leaves unmarked shared-type pages out of the backlog', async () => {
    await seed('email/unmarked', 'email', {});
    await seed('email/marked', 'email', { conversation_parseable: true });
    await seed('conversations/plain', 'conversation', {});
    await engine.setConfig(REQUIRE_PARSEABLE_FLAG_CONFIG_KEY, 'true');
    expect((await computeConversationFactsBacklogCheck(engine)).details?.backlog).toBe(2);
  });

  test('granular collector types count, as the extractor enumerates them', async () => {
    await seed('email/digest', 'email-digest', {});
    expect((await computeConversationFactsBacklogCheck(engine)).details?.backlog).toBe(1);
  });
});
