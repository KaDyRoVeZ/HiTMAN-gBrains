/**
 * Temporal typed edges on Postgres: the shared relationship-state scenario
 * (test/helpers/link-temporal-scenario.ts) against a real database, covering
 * datemultirange text, JSONB recordset binding and the graph generation
 * sequence through postgres.js.
 */
import { afterAll, beforeAll, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { defineLinkRelationshipTests } from '../helpers/link-temporal-scenario.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  test.skip('link relationships Postgres scenario skipped (DATABASE_URL unset)', () => {});
} else {
  let engine: PostgresEngine;
  beforeAll(async () => {
    engine = new PostgresEngine();
    assertSafeE2eDatabaseUrl(databaseUrl);
    await engine.connect({ database_url: databaseUrl });
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });
  defineLinkRelationshipTests('postgres', () => engine, 'lrtpg');
}
