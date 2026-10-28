/**
 * #5876 (T12): the `chronicle_backstop` receipt field and the one reason table.
 *
 * Protects: pending writes report `{ pending: 'next_cycle', daily_remaining }`; skips carry the
 * code, stage, why and a stored fix Action (argv/preview_argv/consent/actor, never `next`) with
 * real values; pages that are not chronicle-shaped get no field; the guide's table is rendered
 * from CHRONICLE_REASONS.
 * Fails when: receipts drift from facts_backstop's plain-field shape, an ordinary note grows
 * `kind:<type>` noise, a paid fix loses its consent, or the docs table drifts from the code.
 * Seams: none. Regenerate the docs table with GBRAIN_TEST_UPDATE_GOLDENS=1.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHRONICLE_REASONS, chronicleBackstopReceipt, renderChronicleReasonTable } from '../src/core/chronicle/reasons.ts';
import { CODES } from '../src/core/error-registry.ts';

const GUIDE = join(import.meta.dir, '..', 'docs', 'guides', 'life-chronicle.md');
const ctx = { sourceId: 'work', since: '2026-10-04', dailyLimit: 200, recentDays: 30, model: 'openai:gpt-new' };

describe('chronicle_backstop receipt', () => {
  test('pending is a plain hint with the remaining daily calls', () => {
    expect(chronicleBackstopReceipt({ state: 'pending' }, { ...ctx, dailyRemaining: 187 }))
      .toEqual({ pending: 'next_cycle', daily_remaining: 187 });
  });

  test('a history skip names the scoped backfill with its preview, paid consent and real values', () => {
    expect(chronicleBackstopReceipt({ state: 'skipped', reason: 'history' }, ctx)).toEqual({
      skipped: 'history', stage: 'decision',
      why: "The page's own date is more than 30 days old (chronicle.auto_recent_days); history is extracted only on request.",
      fix: {
        argv: ['gbrain', 'chronicle-backfill', '--source', 'work', '--since', '2026-10-04', '--limit', '50', '--yes'],
        preview_argv: ['gbrain', 'chronicle-backfill', '--source', 'work', '--since', '2026-10-04', '--limit', '50', '--dry-run'],
        consent: ['paid'], actor: 'agent', requires_exclusive: false,
        why: 'Preview with the dry run, then backfill these pages if the user agrees to one paid chat call per page.',
      },
    });
  });

  test('a pending decision that waits for its end time reports the reason, not next_cycle', () => {
    expect(chronicleBackstopReceipt({ state: 'pending', reason: 'not_yet_happened' }, ctx)).toEqual({
      skipped: 'not_yet_happened', stage: 'decision',
      why: 'The calendar event has not ended yet; it is picked up automatically after its end time, with no edit needed.',
    });
    expect(chronicleBackstopReceipt({ state: 'pending', reason: null }, { ...ctx, dailyRemaining: 3 }))
      .toEqual({ pending: 'next_cycle', daily_remaining: 3 });
  });

  test('confined writers route the fix to the brain host; off-by-choice carries no fix', () => {
    expect(chronicleBackstopReceipt({ state: 'skipped', reason: 'slug_bound_client' }, ctx)).toMatchObject({ fix: { actor: 'host_admin' } });
    const off = chronicleBackstopReceipt({ state: 'skipped', reason: 'auto_chronicle_off' }, ctx);
    expect(off).toMatchObject({ skipped: 'auto_chronicle_off', stage: 'decision' });
    expect(off && 'fix' in off).toBe(false);
  });

  test('pages that are not chronicle-shaped get no field', () => {
    for (const reason of ['kind:note', 'kind:person', 'diary_excluded', 'event_self', 'subagent_scratch']) {
      expect(chronicleBackstopReceipt({ state: 'skipped', reason }, ctx)).toBeUndefined();
    }
  });

  test('no stored fix carries `next` or a rendered command', () => {
    for (const reason of Object.keys(CHRONICLE_REASONS)) {
      const r = chronicleBackstopReceipt({ state: 'skipped', reason }, ctx);
      expect(r).toBeDefined();
      if (r && 'fix' in r && r.fix) {
        expect(Object.keys(r.fix)).not.toContain('next');
        expect(Object.keys(r.fix)).not.toContain('command');
      }
    }
  });

  test('an unknown reason still reports itself with a doctor pointer', () => {
    expect(chronicleBackstopReceipt({ state: 'skipped', reason: 'something_new' }, ctx))
      .toMatchObject({ skipped: 'something_new', fix: { argv: ['gbrain', 'doctor', '--json'] } });
  });
});

describe('docs/guides/life-chronicle.md reason table', () => {
  test('matches CHRONICLE_REASONS', () => {
    const doc = readFileSync(GUIDE, 'utf8');
    const begin = '<!-- chronicle-reasons:begin -->\n';
    const end = '\n<!-- chronicle-reasons:end -->';
    const block = doc.slice(doc.indexOf(begin) + begin.length, doc.indexOf(end));
    const expected = renderChronicleReasonTable();
    if (process.env.GBRAIN_TEST_UPDATE_GOLDENS === '1' && block !== expected) {
      writeFileSync(GUIDE, doc.replace(block, expected));
      return;
    }
    expect(block).toBe(expected);
  });
});

describe('agent-operator registry', () => {
  test('chronicle_skipped lists exactly the CHRONICLE_REASONS codes as its reasons', () => {
    expect([...CODES.chronicle_skipped.reasons].sort() as string[]).toEqual(Object.keys(CHRONICLE_REASONS).sort());
  });
});
