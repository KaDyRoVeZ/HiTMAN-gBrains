/**
 * Engine graduation target side (`src/core/persistence/graduation-target.ts`).
 *
 * Protects: route resolution (`--url` / `--url-env`, explicit and derived DDL
 * routes, no automatic session-pooler route), the target identity hash that
 * excludes the password, redaction (no display form, refusal or blocker
 * carries the password), plan blockers from a probe, and on Postgres the
 * read-only probes (empty database, initialised seed-only schema, a schema
 * with user rows, denied replica mode with table ownership, a non-owner with
 * no bypass, wrong password), the nonce cross-check between routes (same
 * database passes, a different database refuses) and the target engine pair.
 * Fails when: a secret leaks into output, a password rotation changes the
 * identity, a probe writes, or routes naming different databases pass.
 * Seams: none; the Postgres cases need DATABASE_URL.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import postgres from '#postgres';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { TargetProbe } from '../src/core/persistence/engine-graduation.types.ts';
import {
  assertTargetReachable, chooseTriggerBypass, connectTargetEngines, crossCheckRoutes, probeTarget, redactTargetUrl, resolveTargetRoutes,
  targetIdentity, targetProbeBlockers,
} from '../src/core/persistence/graduation-target.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { LAST_KNOWN_OP, queueRefresh } from '../src/commands/doctor/last-known.ts';

const SECRET = 's3cr3t-Pa55';
const thrown = (fn: () => unknown): Record<string, any> => {
  try { fn(); } catch (error) { return (error as { toJSON(): Record<string, any> }).toJSON(); }
  throw new Error('expected a refusal');
};

describe('routes, identity and redaction', () => {
  test('--url-env reads the URL from the named variable; displays never carry the password', () => {
    const routes = resolveTargetRoutes({ urlEnv: 'GBRAIN_TARGET_URL', env: { GBRAIN_TARGET_URL: `postgresql://alice:${SECRET}@db.example.com:6432/brain?sslmode=require&password=${SECRET}` } });
    expect(routes).toMatchObject({ main: 'postgres://alice@db.example.com:6432/brain', ddl: 'postgres://alice@db.example.com:6432/brain', urlEnv: 'GBRAIN_TARGET_URL' });
    expect(routes.ddlUrl).toBe(routes.mainUrl);
    expect(JSON.stringify({ main: routes.main, ddl: routes.ddl })).not.toContain(SECRET);
  });

  test('Supabase transaction pooler derives the direct DDL route; an explicit override wins and is final', () => {
    const url = `postgresql://postgres.abcdefghijklmnop:${SECRET}@aws-0-us-east-1.pooler.supabase.com:6543/postgres`;
    const derived = resolveTargetRoutes({ url, env: {} });
    expect(derived.ddl).toBe('postgres://postgres@db.abcdefghijklmnop.supabase.co:5432/postgres');
    const session = `postgresql://postgres.abcdefghijklmnop:${SECRET}@aws-0-us-east-1.pooler.supabase.com:5432/postgres`;
    const explicit = resolveTargetRoutes({ url, env: { GBRAIN_DIRECT_DATABASE_URL: session } });
    expect(explicit.ddlUrl).toBe(session);
    expect(explicit.ddl).not.toContain(SECRET);
  });

  test('missing, doubled and non-Postgres targets refuse with --url-env commands', () => {
    const missing = thrown(() => resolveTargetRoutes({ urlEnv: 'MY_TARGET', env: {} }));
    expect(missing).toMatchObject({ code: 'graduation_target_unsupported' });
    expect(missing.fix.argv).toEqual(['gbrain', 'migrate', '--to', 'postgres', '--url-env', 'MY_TARGET', '--plan', '--json']);
    expect(thrown(() => resolveTargetRoutes({ url: 'postgres://a@h/d', urlEnv: 'X', env: { X: 'postgres://a@h/d' } })).code).toBe('graduation_target_unsupported');
    const mysql = thrown(() => resolveTargetRoutes({ url: `mysql://root:${SECRET}@h/d`, env: {} }));
    expect(JSON.stringify(mysql)).not.toContain(SECRET);
  });

  test('the identity hashes host, port, database and user, never the password', () => {
    const a = targetIdentity(`postgres://alice:${SECRET}@DB.example.com/brain`);
    const b = targetIdentity('postgres://alice:rotated@db.example.com:5432/brain');
    expect(a).toEqual(b);
    expect(a).toMatchObject({ host: 'db.example.com', port: 5432, database: 'brain', user: 'alice' });
    expect(JSON.stringify(a)).not.toContain(SECRET);
    expect(targetIdentity('postgres://alice:x@db.example.com/other').id).not.toBe(a.id);
    expect(targetIdentity('postgres://bob:x@db.example.com/brain').id).not.toBe(a.id);
    expect(targetIdentity('postgres://alice@db.example.com').database).toBe('alice');
    expect(redactTargetUrl(`postgres://alice:${SECRET}@h:1/d?password=${SECRET}`)).toBe('postgres://alice@h:1/d');
  });
});

const baseProbe: TargetProbe = {
  reachable: true, auth: true, ddl: { reachable: true, auth: true }, serverVersion: '16.4', serverVersionNum: 160004,
  vector: { installed: null, available: '0.8.0', halfvec: true }, createPrivilege: { database: true, schema: true },
  replicaRole: true, ownsTables: true, triggerBypass: 'session_replication_role', gbrainSchema: false, empty: true, nonEmptyTables: [],
  embeddingColumns: [], otherSessions: 0,
};

describe('plan blockers from a probe', () => {
  const routes = { main: 'postgres://alice@h:5432/d', ddl: 'postgres://alice@h:5432/d', urlEnv: 'GBRAIN_TARGET_URL' };
  test('a ready target has none', () => { expect(targetProbeBlockers(baseProbe, routes)).toEqual([]); });

  test('each unmet prerequisite names itself', () => {
    const probe: TargetProbe = { ...baseProbe, serverVersion: '13.9', serverVersionNum: 130009, vector: { installed: '0.6.0', available: '0.6.0', halfvec: false },
      createPrivilege: { database: false, schema: false }, replicaRole: false, ownsTables: false, triggerBypass: null, empty: false, nonEmptyTables: ['pages'],
      embeddingColumns: [{ relation: 'content_chunks', column: 'embedding', type: 'vector(768)', dims: 768 }] };
    const ids = targetProbeBlockers(probe, routes, [{ relation: 'content_chunks', column: 'embedding', type: 'vector(1536)', dims: 1536 }]).map(b => `${b.kind}:${b.id}`);
    expect(ids).toEqual(['target_unsupported:server_version', 'target_unsupported:vector_halfvec', 'target_unsupported:create_privilege',
      'target_unsupported:trigger_bypass', 'target_not_empty:target', 'embedding_dimension:content_chunks.embedding']);
  });

  test('a non-superuser role gets the exact SQL a DBA runs for vector, BYPASSRLS and the auto-RLS event trigger', () => {
    const probe: TargetProbe = { ...baseProbe, vector: { installed: null, available: '0.8.0', halfvec: true },
      role: { name: 'gbrain_app', superuser: false, bypassRls: false }, autoRls: { eventTrigger: false, functionOwner: null } };
    const blockers = targetProbeBlockers(probe, routes);
    expect(blockers.map(b => b.id)).toEqual(['vector_extension', 'bypassrls', 'auto_rls_event_trigger']);
    expect(blockers[0]!.detail).toContain('CREATE EXTENSION IF NOT EXISTS vector;');
    expect(blockers[1]!.detail).toContain('ALTER ROLE "gbrain_app" BYPASSRLS;');
    expect(blockers[2]!.detail).toContain('ALTER FUNCTION public.auto_enable_rls() OWNER TO "gbrain_app";');
    const owned = targetProbeBlockers({ ...probe, vector: { installed: '0.8.0', available: '0.8.0', halfvec: true }, role: { name: 'gbrain_app', superuser: false, bypassRls: true },
      autoRls: { eventTrigger: true, functionOwner: 'postgres' } }, routes);
    expect(owned.map(b => b.id)).toEqual(['auto_rls_owner']);
    expect(targetProbeBlockers({ ...probe, role: { name: 'postgres', superuser: true, bypassRls: true } }, routes)).toEqual([]);
  });

  test('auth failure, unreachable DDL route and the forced bypass', () => {
    const auth = thrown(() => assertTargetReachable({ ...baseProbe, auth: false, error: { code: '28P01', message: 'password authentication failed' } }, routes));
    expect(auth).toMatchObject({ code: 'graduation_target_auth_failed' });
    expect(auth.fix.argv).toContain('--url-env');
    const ddl = thrown(() => assertTargetReachable({ ...baseProbe, ddl: { reachable: false, auth: false, error: { code: 'ENETUNREACH', message: 'x' } } }, routes));
    expect(ddl).toMatchObject({ code: 'graduation_target_ddl_unreachable' });
    expect(ddl.suggestion).toContain('GBRAIN_DIRECT_DATABASE_URL');
    expect(chooseTriggerBypass({ replicaRole: false, triggerBypass: 'disable_trigger' }, 'session_replication_role')).toBeNull();
    expect(chooseTriggerBypass({ replicaRole: true, triggerBypass: 'session_replication_role' }, 'disable_trigger')).toBe('disable_trigger');
  });
});

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)('Postgres probes and the route cross-check', () => {
  const created: string[] = [];
  const roles: string[] = [];
  const admin = databaseUrl ? (assertSafeE2eDatabaseUrl(databaseUrl), postgres(databaseUrl, { max: 1, prepare: false, onnotice: () => {} })) : null;
  const urlFor = (database: string, user?: string, password?: string) => {
    const url = new URL(databaseUrl!); url.pathname = `/${database}`;
    if (user) { url.username = user; url.password = password ?? ''; }
    return url.toString();
  };
  const freshDatabase = async (owner?: string) => {
    const name = `gbrain_test_graduation_target_${randomUUID().replace(/-/g, '')}`;
    await admin!.unsafe(`CREATE DATABASE ${name}${owner ? ` OWNER ${owner}` : ''}`);
    created.push(name);
    return name;
  };
  afterAll(async () => {
    for (const name of created) await admin!.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
    for (const role of roles) await admin!.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    await admin?.end();
  });

  test('empty, seed-only and non-empty targets; probes never write', async () => {
    const name = await freshDatabase();
    const routes = resolveTargetRoutes({ url: urlFor(name), env: {} });
    const empty = await probeTarget(routes);
    expect(empty).toMatchObject({ reachable: true, auth: true, empty: true, gbrainSchema: false, replicaRole: true, triggerBypass: 'session_replication_role',
      createPrivilege: { database: true, schema: true }, ddl: { reachable: true, auth: true } });
    expect(empty.serverVersionNum).toBeGreaterThanOrEqual(140000);
    expect(empty.vector.halfvec).toBe(true);
    expect(targetProbeBlockers(empty, routes)).toEqual([]);
    const db = postgres(routes.mainUrl, { max: 1, onnotice: () => {} });
    const [relations] = await db.unsafe("SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'");
    expect(relations!.n).toBe(0);
    await db.end();

    const engine = new PostgresEngine();
    await engine.connect({ database_url: routes.mainUrl, poolSize: 2 });
    try {
      await engine.initSchema();
      const seeded = await probeTarget(routes);
      expect(seeded).toMatchObject({ empty: true, gbrainSchema: true, nonEmptyTables: [] });
      expect(seeded.embeddingColumns.map(c => `${c.relation}.${c.column}`)).toEqual(expect.arrayContaining(['content_chunks.embedding', 'facts.embedding']));
      // #7142: a doctor run's last known results and its queued refresh are not brain data.
      await engine.executeRaw(`INSERT INTO op_checkpoints (op, fingerprint, completed_keys) VALUES ($1, 'queue_health', '[{}]'::jsonb), ($1, 'schema_version', '[{}]'::jsonb)`, [LAST_KNOWN_OP]);
      expect(await queueRefresh(engine)).not.toBeNull();
      expect(await probeTarget(routes)).toMatchObject({ empty: true, nonEmptyTables: [] });
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('notes', 'Notes')");
      await engine.executeRaw("UPDATE persistence_brain SET enabled = true");
      const used = await probeTarget(routes);
      expect(used.empty).toBe(false);
      expect(used.nonEmptyTables).toEqual(['persistence_brain', 'sources']);
    } finally { await engine.disconnect(); }
  }, 120_000);

  test('a wrong password is an auth failure with nothing secret in the refusal', async () => {
    const name = await freshDatabase();
    const routes = resolveTargetRoutes({ url: urlFor(name, new URL(databaseUrl!).username, SECRET), env: {} });
    const probe = await probeTarget(routes, { timeoutSeconds: 5 });
    expect(probe).toMatchObject({ reachable: true, auth: false });
    const json = thrown(() => assertTargetReachable(probe, routes));
    expect(json.code).toBe('graduation_target_auth_failed');
    expect(JSON.stringify({ json, probe })).not.toContain(SECRET);
  }, 60_000);

  test('a non-superuser owner cannot use replica mode but owns its tables; a non-owner has no bypass', async () => {
    const owner = `gbrain_grad_owner_${randomUUID().slice(0, 8)}`;
    const other = `gbrain_grad_other_${randomUUID().slice(0, 8)}`;
    await admin!.unsafe(`CREATE ROLE ${owner} LOGIN PASSWORD 'pw'`); roles.push(owner);
    await admin!.unsafe(`CREATE ROLE ${other} LOGIN PASSWORD 'pw'`); roles.push(other);
    const name = await freshDatabase(owner);
    const db = postgres(urlFor(name), { max: 1, onnotice: () => {} });
    await db.unsafe(`ALTER SCHEMA public OWNER TO ${owner}`);
    await db.unsafe(`CREATE TABLE owned (id int PRIMARY KEY)`);
    await db.unsafe(`ALTER TABLE owned OWNER TO ${owner}`);
    await db.unsafe(`GRANT CONNECT ON DATABASE ${name} TO ${other}`);
    await db.end();
    const ownerProbe = await probeTarget(resolveTargetRoutes({ url: urlFor(name, owner, 'pw'), env: {} }));
    expect(ownerProbe).toMatchObject({ replicaRole: false, ownsTables: true, triggerBypass: 'disable_trigger' });
    const otherProbe = await probeTarget(resolveTargetRoutes({ url: urlFor(name, other, 'pw'), env: {} }));
    expect(otherProbe).toMatchObject({ replicaRole: false, ownsTables: false, triggerBypass: null });
    expect(targetProbeBlockers(otherProbe, { main: 'm' }).map(b => b.id)).toContain('trigger_bypass');
  }, 60_000);

  test('the nonce cross-check passes for one database and refuses a DDL route to another', async () => {
    const a = await freshDatabase();
    const b = await freshDatabase();
    const pair = await connectTargetEngines(resolveTargetRoutes({ url: urlFor(a), env: { GBRAIN_DIRECT_DATABASE_URL: urlFor(a) } }));
    try {
      await crossCheckRoutes(pair.main, pair.ddl, 'run-same');
    } finally { await pair.close(); }
    const wrong = await connectTargetEngines(resolveTargetRoutes({ url: urlFor(a), env: { GBRAIN_DIRECT_DATABASE_URL: urlFor(b) } }));
    try {
      let error: unknown;
      try { await crossCheckRoutes(wrong.main, wrong.ddl, 'run-wrong'); } catch (e) { error = e; }
      const json = (error as { toJSON(): Record<string, any> }).toJSON();
      expect(json.code).toBe('graduation_target_ddl_unreachable');
      expect(json.why).toContain('run-wrong');
    } finally { await wrong.close(); }
    expect(process.env.GBRAIN_DIRECT_DATABASE_URL).toBeUndefined();
  }, 60_000);
});
