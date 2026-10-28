/**
 * Postgres arm of the #5904 probe (E28): `extract timeline --source db` on a
 * managed Postgres brain writes through the coordinator; a refusal exits non-zero.
 */
import { describe, test } from 'bun:test';
import { managedTimelineDbRefusalExitsNonZero, managedTimelineDbWritesThroughCoordinator } from '../helpers/extract-timeline-db-scenarios.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres managed extract timeline --source db', () => {
  test('writes the missing rows through the coordinator', () => managedTimelineDbWritesThroughCoordinator(url), 180_000);
  test('a refused write says nothing was written and exits non-zero', () => managedTimelineDbRefusalExitsNonZero(url), 180_000);
});
