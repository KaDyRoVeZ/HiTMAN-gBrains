import { test } from 'bun:test';
import { hasDatabase } from './helpers.ts';

if (hasDatabase()) {
  await import('../write-attribution-read.test.ts');
} else {
  test.skip('write attribution read parity requires PostgreSQL', () => {});
}
