/** #4732 Postgres arm: get_health names the registry-active embedding column. */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { assertHealthNamesActiveColumn } from '../helpers/health-embedding-column.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';

describe.skipIf(!hasDatabase())('get_health embedding_column (Postgres)', () => {
  let engine: PostgresEngine;
  beforeAll(async () => { engine = await setupDB(); });
  afterAll(async () => {
    await engine.executeRaw('ALTER TABLE content_chunks DROP COLUMN IF EXISTS embedding_reg8');
    await teardownDB();
  });

  test('names the registry-active column coverage was measured on', () => assertHealthNamesActiveColumn(engine));
});
