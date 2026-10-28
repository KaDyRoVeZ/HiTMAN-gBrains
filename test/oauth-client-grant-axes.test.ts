/**
 * OAuth clients hold the two grant axes legacy tokens already had (Lane E):
 * `auth rescope --client <id> --sources none` (the explicit no-source grant)
 * and `--takes-holders a,b|none` (a per-client takes-holder allow-list).
 *
 * Protects: `--sources none` stores NULL source_id + empty federated_read +
 * source_grant 'none', verifies as NO_SOURCES, refuses reads, writes and the
 * publication of a write accepted before the change, and `--sources <id>`
 * restores it; per-client takes holders reach AuthInfo and the publication
 * reauthorization, `none` hides every take, invalid holders refuse; a
 * delegating agent cannot hold `none`; an untouched client keeps its grant.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { parseClientRescopeArgs } from '../src/core/grants/cli.ts';
import { rescopeClientGrant, readClientGrant } from '../src/core/grants/service.ts';
import { grantFromClient } from '../src/core/grants/model.ts';
import { NO_SOURCES } from '../src/core/source-id.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { authorizeStoredRequest, authorizeTakeHolder, submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('other','other') ON CONFLICT DO NOTHING");
  await engine.putPage('notes/axes', { type: 'note', title: 'Axes', compiled_truth: 'axes-marker prose', timeline: '', frontmatter: {} }, { sourceId: 'default' });
}, 120_000);

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
const rescope = async (clientId: string, ...args: string[]) => {
  const parsed = parseClientRescopeArgs(clientId, args);
  return rescopeClientGrant(engine, clientId, parsed.patch, { actor: 'test', expectedRevision: (await readClientGrant(engine, clientId)).revision });
};
async function client(scopes = 'read write') {
  const p = provider();
  const { clientId, clientSecret } = await p.registerClientManual(`axes-${randomUUID().slice(0, 8)}`, ['client_credentials'], scopes, [], 'default', ['default', 'other']);
  const tokens = await p.exchangeClientCredentials(clientId, clientSecret!);
  return { clientId, token: tokens.access_token };
}
const verify = async (token: string) => await provider().verifyAccessToken(token) as unknown as AuthInfo;
const row = async (clientId: string) => (await engine.executeRaw<Record<string, unknown>>('SELECT * FROM oauth_clients WHERE client_id = $1', [clientId]))[0];

describe('--sources none for OAuth clients', () => {
  test('stores the explicit no-source grant, verifies as NO_SOURCES, refuses reads, writes and stale publication; --sources restores', async () => {
    const c = await client();
    const before = await verify(c.token);
    const ctx = { engine, config: { engine: 'pglite' }, sourceId: 'default', auth: before, remote: true, dryRun: false,
      logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
    const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
    const authority = await submissionAuthority(ctx, 'put_page', 'default', source.incarnation, 'notes/axes');
    const admitted = await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default',
      sourceIncarnation: source.incarnation, slug: 'notes/axes', requestId: randomUUID(), callerIntent: {}, intent: {} });
    await authorizeStoredRequest(engine, admitted);

    const result = await rescope(c.clientId, '--sources', 'none');
    expect(result.after).toMatchObject({ sourcesNone: true, sourceId: null, federatedRead: [] });
    expect(grantFromClient(result.after).sources).toEqual({ kind: 'none' });
    expect(await row(c.clientId)).toMatchObject({ source_grant: 'none', source_id: null, federated_read: [] });
    await expect(authorizeStoredRequest(engine, admitted)).rejects.toMatchObject({ code: 'permission_denied' });

    const auth = await verify(c.token);
    expect(auth).toMatchObject({ sourceId: NO_SOURCES, allowedSources: [], hasSourceGrant: true, scopes: ['read', 'write'] });
    for (const [op, args] of [['search', { query: 'axes-marker' }], ['get_page', { slug: 'notes/axes' }], ['query', { query: 'axes-marker', source_id: 'other' }],
      ['put_page', { slug: 'notes/axes-new', content: 'x' }]] as const) {
      const out = await dispatchToolCall(engine, op, { ...args }, { remote: true, transport: 'http', sourceId: auth.sourceId, auth });
      expect({ op, error: JSON.parse(out.content[0].text).error }).toEqual({ op, error: 'permission_denied' });
    }

    const restored = await rescope(c.clientId, '--sources', 'default,other');
    expect(restored.after).toMatchObject({ sourcesNone: false, sourceId: 'default', federatedRead: ['default', 'other'] });
    expect(await row(c.clientId)).toMatchObject({ source_grant: null, source_id: 'default' });
    expect(await verify(c.token)).toMatchObject({ sourceId: 'default', allowedSources: ['default', 'other'] });
  }, 120_000);

  test('the legacy --source flag also leaves the no-source grant', async () => {
    const c = await client();
    await rescope(c.clientId, '--sources', 'none');
    const result = await rescope(c.clientId, '--source', 'other', '--federated-read', 'other');
    expect(result.after).toMatchObject({ sourcesNone: false, sourceId: 'other', federatedRead: ['other'] });
  });

  test('refuses --read-sources with none, and none on a delegating agent', async () => {
    expect(() => parseClientRescopeArgs('c', ['--sources', 'none', '--read-sources', 'other'])).toThrow(/takes no --read-sources/);
    const p = provider();
    const { clientId } = await p.registerClientManual(`axes-agent-${randomUUID().slice(0, 8)}`, ['client_credentials'], 'read agent', [], 'default', ['default'], undefined,
      { boundTools: ['search'], boundSourceId: 'default', boundSlugPrefixes: ['wiki/agents/'] });
    await expect(rescope(clientId, '--sources', 'none')).rejects.toMatchObject({ code: 'invalid_grant', reasons: expect.arrayContaining(['source_inactive']) });
  });
});

describe('per-client takes holders', () => {
  test('an untouched client keeps the default holders', async () => {
    const c = await client();
    expect((await verify(c.token)).takesHoldersAllowList).toBeUndefined();
    expect((await readClientGrant(engine, c.clientId)).takesHolders).toBeNull();
  });

  test('holders reach AuthInfo and publication reauthorization; none hides every take', async () => {
    const c = await client();
    const result = await rescope(c.clientId, '--takes-holders', 'world,brain,people/alice-example');
    expect(result.after.takesHolders).toEqual(['world', 'brain', 'people/alice-example']);
    expect(await row(c.clientId)).toMatchObject({ takes_holders: ['world', 'brain', 'people/alice-example'] });
    const auth = await verify(c.token);
    expect(auth.takesHoldersAllowList).toEqual(['world', 'brain', 'people/alice-example']);
    const authority = { remote: true, principal: { kind: 'oauth_client' as const, id: c.clientId }, takesHolders: auth.takesHoldersAllowList } as Parameters<typeof authorizeTakeHolder>[1];
    await authorizeTakeHolder(engine, authority, 'brain');
    await rescope(c.clientId, '--takes-holders', 'world');
    await expect(authorizeTakeHolder(engine, authority, 'brain')).rejects.toMatchObject({ code: 'permission_denied' });
    await rescope(c.clientId, '--takes-holders', 'none');
    expect((await verify(c.token)).takesHoldersAllowList).toEqual([]);
    expect(await row(c.clientId)).toMatchObject({ takes_holders: [] });
  });

  test('invalid holders refuse before any write', async () => {
    expect(() => parseClientRescopeArgs('c', ['--takes-holders', 'world,Not A Holder'])).toThrow(/Invalid takes holder/);
  });
});
