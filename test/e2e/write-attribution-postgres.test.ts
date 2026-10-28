import { test } from 'bun:test';
import { hasDatabase } from './helpers.ts';

// Foundations 1 write attribution on Postgres: the transaction-local actor
// settings and BEFORE ROW triggers, run direct and through transaction-mode
// PgBouncer (scripts/e2e-backend-matrix.txt). The legacy file covers the
// unmanaged transactional writers (F1c); the write-attribution-<family> files
// cover the writers Foundations 2 routed (Lane C). The 10k-page timeline run
// is its own file (write-attribution-timeline-10k-postgres.test.ts) so a CI
// queue can run it beside this one.
if (hasDatabase()) {
  await import('../write-attribution.test.ts');
  await import('../write-attribution-legacy.test.ts');
  await import('../write-attribution-import.test.ts');
  await import('../write-attribution-sync.test.ts');
  await import('../write-attribution-timeline.test.ts');
  await import('../write-attribution-facts-takes.test.ts');
  await import('../write-attribution-cycle.test.ts');
  await import('../write-attribution-schema-pack.test.ts');
  await import('../write-attribution-misc.test.ts');
} else {
  test.skip('write attribution on Postgres requires DATABASE_URL', () => {});
}
