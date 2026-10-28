/**
 * OAuth client `--sources none` and per-client takes holders on real
 * Postgres: the text[] holder list round-trips with quoting intact through
 * the jsonb_array_elements bind, verifyAccessToken reads both axes from the
 * client row, and the no-source grant clears source_id under the FK.
 * PGLite coverage: test/oauth-client-grant-axes.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { parseClientRescopeArgs } from '../../src/core/grants/cli.ts';
import { readClientGrant, rescopeClientGrant } from '../../src/core/grants/service.ts';
import { NO_SOURCES } from '../../src/core/source-id.ts';

const d = hasDatabase() ? describe : describe.skip;

beforeAll(async () => { if (hasDatabase()) await setupDB(); });
afterAll(async () => { if (hasDatabase()) await teardownDB(); });

const provider = () => { const engine = getEngine(); return new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) }); };
const rescope = async (clientId: string, ...args: string[]) => rescopeClientGrant(getEngine(), clientId, parseClientRescopeArgs(clientId, args).patch,
  { actor: 'e2e', expectedRevision: (await readClientGrant(getEngine(), clientId)).revision });

d('OAuth client grant axes on Postgres', () => {
  test('takes holders round-trip and verify; --sources none verifies as NO_SOURCES and restores', async () => {
    const p = provider();
    const { clientId, clientSecret } = await p.registerClientManual(`axes-e2e-${randomUUID().slice(0, 8)}`, ['client_credentials'], 'read write');
    const { access_token } = await p.exchangeClientCredentials(clientId, clientSecret!);
    const holders = ['world', 'people/alice-example', 'brain'];
    await rescope(clientId, '--takes-holders', holders.join(','));
    const [row] = await getEngine().executeRaw<Record<string, unknown>>('SELECT takes_holders, source_grant FROM oauth_clients WHERE client_id = $1', [clientId]);
    expect(row).toEqual({ takes_holders: holders, source_grant: null });
    expect(await p.verifyAccessToken(access_token)).toMatchObject({ takesHoldersAllowList: holders, sourceId: 'default' });

    await rescope(clientId, '--sources', 'none');
    expect(await p.verifyAccessToken(access_token)).toMatchObject({ sourceId: NO_SOURCES, allowedSources: [], hasSourceGrant: true, takesHoldersAllowList: holders });
    const [none] = await getEngine().executeRaw<Record<string, unknown>>('SELECT source_id, federated_read, source_grant FROM oauth_clients WHERE client_id = $1', [clientId]);
    expect(none).toEqual({ source_id: null, federated_read: [], source_grant: 'none' });

    await rescope(clientId, '--sources', 'default');
    expect(await p.verifyAccessToken(access_token)).toMatchObject({ sourceId: 'default', allowedSources: ['default'] });
  });
});
