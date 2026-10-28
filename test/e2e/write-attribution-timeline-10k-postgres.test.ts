import { test } from 'bun:test';
import { hasDatabase } from './helpers.ts';

// Foundations 1 write attribution on Postgres for `extract timeline --source
// db` at 10k pages (bounded per-batch transactions), direct and through
// transaction-mode PgBouncer (scripts/e2e-backend-matrix.txt). Split from
// write-attribution-postgres.test.ts.
if (hasDatabase()) {
  await import('../write-attribution-timeline-10k.slow.test.ts');
} else {
  test.skip('write attribution on Postgres requires DATABASE_URL', () => {});
}
