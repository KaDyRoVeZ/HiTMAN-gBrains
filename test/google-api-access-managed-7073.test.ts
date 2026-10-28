/**
 * #7073 on a managed Google source (real PGLite, and Postgres when
 * DATABASE_URL is set): with the People API disabled and OAuth userinfo
 * answering, the account resolves and pins, the run reports the disabled API
 * instead of refusing, and doctor google_api_access reads the stored record
 * with no network call. A different account behind userinfo still refuses
 * connector_account_changed.
 *
 * Synthetic responses only: example.invalid addresses, a made-up project.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseGoogleSourceConfig, runGoogleSync } from '../src/core/google/google-source.ts';
import { readManagedConnectorState } from '../src/core/persistence/connector-state.ts';
import { googleApiAccessCheck } from '../src/commands/doctor/checks/google-api-access.ts';
import { withEnv } from './helpers/with-env.ts';
import { createConnectorFixture, options, json, googleConfig } from './helpers/connector-fixture.ts';

const { engines, env, source, setup, teardown } = createConnectorFixture();
beforeAll(setup, 120_000);
afterAll(teardown);

const PROJECT = '987654321';
const ENABLE_URL = `https://console.developers.google.com/apis/api/people.googleapis.com/overview?project=${PROJECT}`;
const incarnation = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [id]))[0].incarnation;

function peopleDisabled(userinfoAccount: string) {
  return async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/settings/sendAs')) return json({ sendAs: [] });
    if (path.endsWith('/v1/userinfo')) return json({ email: userinfoAccount });
    if (path.includes('/people/')) {
      return json({ error: { code: 403, status: 'PERMISSION_DENIED', message: `People API has not been used in project ${PROJECT} before or it is disabled.`,
        errors: [{ reason: 'accessNotConfigured' }],
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED',
          metadata: { service: 'people.googleapis.com', serviceTitle: 'People API', consumer: `projects/${PROJECT}`, activationUrl: ENABLE_URL } }] } }, 403);
    }
    throw new Error(`unexpected route ${url}`);
  };
}

test('disabled People API with a valid userinfo: the account pins, the run is partial, doctor names the API', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const result = await runGoogleSync(engine, f.id, parseGoogleSourceConfig(googleConfig, f.dir), options, peopleDisabled(googleConfig.g_account));
    expect(result.status).toBe('partial');
    const state = await readManagedConnectorState(engine, f.id, await incarnation(engine, f.id));
    expect(state.account).toEqual({ kind: 'google', email: googleConfig.g_account });
    expect(state.account_mismatch ?? null).toBeNull();

    const check = await googleApiAccessCheck(engine, [f.id]);
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ count: 1, sources: [{ source_id: f.id, account: googleConfig.g_account,
      problems: [{ service: 'contacts', code: 'api_not_enabled', api: 'people.googleapis.com', project: PROJECT, enable_url: ENABLE_URL }] }] });
    expect(check.message).toContain(ENABLE_URL);
    expect(check.fix).toMatchObject({ ask_user: true, actor: 'user', verify: { argv: ['gbrain', 'google', 'status', '--json'] } });
  }
}), 180_000);

test('a different account behind userinfo still refuses connector_account_changed', async () => withEnv(env, async () => {
  for (const engine of engines) {
    const f = await source(engine, googleConfig);
    const refused = await runGoogleSync(engine, f.id, parseGoogleSourceConfig(googleConfig, f.dir), options, peopleDisabled('someone-else@example.invalid')).catch(e => e);
    expect(refused).toMatchObject({ code: 'connector_account_changed', detail: 'account_changed' });
    expect((refused as { suggestion: string }).suggestion).toContain('the credential resolves to someone-else@example.invalid');
  }
}), 180_000);
