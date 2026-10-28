/**
 * #4732: get_health reported 0% embed coverage on a fully embedded brain
 * because coverage was measured on a different vector column than the one
 * holding the vectors, and nothing in the payload said which column that was.
 * `embedding_column` now names the column coverage and missing_embeddings
 * were measured on (the same registry resolution getHealth uses).
 *
 * Regression that fails it: dropping the field, or naming a column other than
 * the registry-active one. The Postgres arm is
 * test/e2e/get-health-embedding-column-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { assertHealthNamesActiveColumn } from './helpers/health-embedding-column.ts';

describe('get_health embedding_column (PGLite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
  afterAll(async () => { await engine.disconnect(); });

  test('names the registry-active column coverage was measured on', () => assertHealthNamesActiveColumn(engine));
});
