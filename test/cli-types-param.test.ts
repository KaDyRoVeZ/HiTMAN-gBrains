/**
 * #7173: `--types` takes the bare and comma forms its help and the op's own
 * errors suggest (`--types company`, `--types person,company`), as well as
 * a JSON array. Before the fix the generic CLI parser JSON-parsed every
 * array param and refused both with `--types requires a JSON array`.
 */
import { describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { parseOpArgs } from '../src/cli/main.ts';

const op = (name: string) => operations.find(o => o.name === name)! as never;

describe('--types on search and query (#7173)', () => {
  test('a bare value is a one-type list', () => {
    expect(parseOpArgs(op('search'), ['q', '--types', 'company']).types).toEqual(['company']);
    expect(parseOpArgs(op('query'), ['q', '--types', 'interview-transcript']).types).toEqual(['interview-transcript']);
  });

  test('a comma list splits, with spaces trimmed', () => {
    expect(parseOpArgs(op('search'), ['q', '--types', 'person,company']).types).toEqual(['person', 'company']);
    expect(parseOpArgs(op('search'), ['q', '--types=person, company']).types).toEqual(['person', 'company']);
  });

  test('a JSON array still works, and malformed JSON is still a usage error', () => {
    expect(parseOpArgs(op('query'), ['q', '--types', '["person"]']).types).toEqual(['person']);
    expect(() => parseOpArgs(op('query'), ['q', '--types', '["person"'])).toThrow('--types requires a JSON array');
  });
});
