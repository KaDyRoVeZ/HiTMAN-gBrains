/**
 * Temporal typed edges — relationship state refresh and the liveness filter on
 * a real PGLite brain (schema + migration + shared refresh). The Postgres twin
 * is test/e2e/link-relationships-postgres.test.ts.
 */
import { afterAll, beforeAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { defineLinkRelationshipTests } from './helpers/link-temporal-scenario.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

defineLinkRelationshipTests('pglite', () => engine);
