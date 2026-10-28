/**
 * Dashboard API keys on real Postgres: the scoped mint binds scopes and the
 * grant columns as text[] through postgres.js, the permissions mirror is a
 * JSONB object (double-encode class), the minted key authenticates with
 * exactly its grant, and revoke by id leaves a same-name sibling active.
 * PGLite coverage: test/serve-http-api-keys.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { mountAdminApiKeys } from '../../src/commands/serve-http-api-keys.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';

const d = hasDatabase() ? describe : describe.skip;
let server: Server | undefined;
let base = '';

beforeAll(async () => {
  if (!hasDatabase()) return;
  const engine = await setupDB();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('team-e2e','team-e2e') ON CONFLICT DO NOTHING");
  const app = express();
  mountAdminApiKeys(app, (_req, _res, next) => next(), engine);
  server = app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(r => server!.close(() => r())); }
  if (hasDatabase()) await teardownDB();
});

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
};

d('dashboard API keys on Postgres', () => {
  test('scoped mint lands on text[] columns with an object mirror and authenticates with exactly its grant', async () => {
    const engine = getEngine();
    const { status, body } = await post('/admin/api/api-keys', { name: 'dash-e2e', sources: ['team-e2e'], takes_holders: ['world', 'people/alice-example'] });
    expect(status).toBe(200);
    expect(body).toMatchObject({ scopes_applied: ['read', 'write'], defaults_applied: ['scopes'] });
    const [row] = await engine.executeRaw<Record<string, unknown>>('SELECT *, jsonb_typeof(permissions) AS kind FROM access_tokens WHERE id = $1::uuid', [body.id]);
    expect(row).toMatchObject({ kind: 'object', scopes: ['read', 'write'], source_grant: 'federated', source_id: 'team-e2e', federated_read: ['team-e2e'],
      takes_holders: ['world', 'people/alice-example'], grant_revision: 1 });
    const auth = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine) }).verifyAccessToken(body.token) as unknown as Record<string, unknown>;
    expect(auth).toMatchObject({ scopes: ['read', 'write'], sourceId: 'team-e2e', allowedSources: ['team-e2e'], takesHoldersAllowList: ['world', 'people/alice-example'] });
  });

  test('revoke by id leaves the same-name sibling active', async () => {
    const engine = getEngine();
    const a = (await post('/admin/api/api-keys', { name: 'dash-e2e-twin', scopes: ['read'] })).body;
    const b = (await post('/admin/api/api-keys', { name: 'dash-e2e-twin', scopes: ['read'] })).body;
    expect((await post('/admin/api/api-keys/revoke', { id: a.id })).body).toEqual({ id: a.id, revoked: true });
    const rows = await engine.executeRaw<{ id: string; revoked: boolean }>('SELECT id, revoked_at IS NOT NULL AS revoked FROM access_tokens WHERE id = ANY($1::uuid[])', [[a.id, b.id]]);
    expect(Object.fromEntries(rows.map(r => [r.id, r.revoked]))).toEqual({ [a.id]: true, [b.id]: false });
  });
});
