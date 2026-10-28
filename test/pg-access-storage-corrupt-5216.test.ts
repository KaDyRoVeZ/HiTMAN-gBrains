/**
 * #5216 / #4738: storage damage (a torn TOAST value, "tuple concurrently
 * deleted") used to surface as a bare XX000 with no recovery hint. The
 * classifier names it `storage_corrupt` and points at the repair preview;
 * other internal errors stay unclassified.
 */
import { expect, test } from 'bun:test';
import { classifyPgAccessError } from '../src/core/pg-access-classify.ts';
import { REPAIR_KINDS } from '../src/core/repair/core.ts';

const xx000 = (message: string) => Object.assign(new Error(message), { code: 'XX000' });

test.each([
  'unexpected chunk number 21 (expected 1) for toast value 141869 in pg_toast_16808',
  'missing chunk number 0 for toast value 99 in pg_toast_2619',
  'tuple concurrently deleted',
])('%s → storage_corrupt with the orphan-children preview as the fix', (message) => {
  const d = classifyPgAccessError(xx000(message));
  expect(d.reason).toBe('storage_corrupt');
  expect(d.transient).toBe(false);
  expect(d.fix).toEqual({ kind: 'run_command', argv: ['gbrain', 'repair', 'orphan-children'] });
  expect(d.remediation).toContain('docs/guides/repair.md#orphan-children');
  expect(REPAIR_KINDS).toContain('orphan-children');
});

test('an unrelated internal error is not called storage damage', () => {
  expect(classifyPgAccessError(xx000('cache lookup failed for type 12345')).reason).toBe('unknown');
});
