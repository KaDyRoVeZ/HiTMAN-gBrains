import { describe, test, expect } from 'bun:test';
import {
  hasUnresolvedRelativeDate,
  observationDateFrom,
  observationDateLine,
  observationDateRule,
  parseExtractedEventDate,
  resolveObservationDate,
  resolveValidFrom,
} from '../../src/core/ai/date-grounding.ts';

describe('resolveObservationDate', () => {
  test('dated slugs and filenames are observation dates', () => {
    expect(resolveObservationDate({ slug: 'meetings/2026-04-03-acme-example-sync' })).toEqual({ date: '2026-04-03', source: 'filename' });
    expect(resolveObservationDate({ slug: 'daily/2026-05-20' })).toEqual({ date: '2026-05-20', source: 'filename' });
  });

  test('frontmatter date and published count; event_date never does', () => {
    expect(resolveObservationDate({ slug: 'notes/x', frontmatter: { date: '2025-11-02' } })).toEqual({ date: '2025-11-02', source: 'date' });
    expect(resolveObservationDate({ slug: 'writing/y', frontmatter: { published: '2024-01-15' } })).toEqual({ date: '2024-01-15', source: 'published' });
    expect(resolveObservationDate({ slug: 'events/launch', frontmatter: { event_date: '2026-09-01' } })).toBeNull();
    expect(resolveObservationDate({ slug: 'events/launch', frontmatter: { event_date: '2026-09-01', date: '2026-03-01' } }))
      .toEqual({ date: '2026-03-01', source: 'date' });
  });

  test('undated pages return null, never now or row timestamps', () => {
    expect(resolveObservationDate({ slug: 'people/alice-example' })).toBeNull();
    expect(resolveObservationDate({ slug: 'people/alice-example', frontmatter: { title: 'Alice' } })).toBeNull();
  });
});

describe('observationDateFrom', () => {
  test('dates and ISO strings become caller observations; garbage is null', () => {
    expect(observationDateFrom('2026-03-10T23:15:00Z')).toEqual({ date: '2026-03-10', source: 'caller' });
    expect(observationDateFrom(new Date('2026-03-10T00:00:00Z'))).toEqual({ date: '2026-03-10', source: 'caller' });
    expect(observationDateFrom('not a date')).toBeNull();
    expect(observationDateFrom(null)).toBeNull();
  });
});

describe('prompt text', () => {
  test('the system rule is static and forbids resolving against today', () => {
    expect(observationDateRule()).toBe(observationDateRule());
    expect(observationDateRule()).toContain("never against today's date");
    expect(observationDateRule()).toContain('Do not leave the relative phrase beside its date');
    expect(observationDateRule()).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
  test('the user line carries the date or says unknown', () => {
    expect(observationDateLine({ date: '2026-03-10', source: 'filename' })).toContain('2026-03-10');
    expect(observationDateLine(null)).toContain('unknown');
  });
});

describe('parseExtractedEventDate', () => {
  const now = new Date('2026-10-04T00:00:00Z');
  test('accepts calendar dates in range', () => {
    expect(parseExtractedEventDate('2024-02-29', now)?.toISOString()).toBe('2024-02-29T00:00:00.000Z');
    expect(parseExtractedEventDate(' 2027-10-01 ', now)?.toISOString()).toBe('2027-10-01T00:00:00.000Z');
  });
  test('rejects malformed, impossible, ancient and far-future dates', () => {
    for (const v of ['2023-02-29', '2026-13-01', 'last week', '2026/03/01', '1899-12-31', '2027-10-05', 20260301, null, undefined]) {
      expect(parseExtractedEventDate(v, now)).toBeNull();
    }
  });
});

describe('resolveValidFrom precedence', () => {
  const now = new Date('2026-10-04T12:00:00Z');
  const obs = { date: '2026-03-10', source: 'filename' as const };
  test('extracted > caller > observation > now', () => {
    const extracted = new Date('2024-05-01T00:00:00Z');
    const caller = new Date('2026-01-01T00:00:00Z');
    expect(resolveValidFrom({ extracted, caller, observation: obs, now })).toEqual({ date: extracted, source: 'extracted' });
    expect(resolveValidFrom({ caller, observation: obs, now })).toEqual({ date: caller, source: 'caller' });
    expect(resolveValidFrom({ observation: obs, now })).toEqual({ date: new Date('2026-03-10T00:00:00Z'), source: 'observation' });
    expect(resolveValidFrom({ now })).toEqual({ date: now, source: 'now' });
  });
});

describe('hasUnresolvedRelativeDate', () => {
  test('a relative phrase followed by a parenthesized date counts as resolved', () => {
    expect(hasUnresolvedRelativeDate('User went to Lisbon last week')).toBe(true);
    expect(hasUnresolvedRelativeDate('User went to Lisbon last week (week of 2026-03-02)')).toBe(false);
    expect(hasUnresolvedRelativeDate('Alice joined 3 weeks ago')).toBe(true);
    expect(hasUnresolvedRelativeDate('Alice joined in March 2026')).toBe(false);
  });
});
