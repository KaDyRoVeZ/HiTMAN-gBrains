/**
 * #7248: remember with a folder-less entity resolves to exactly one readable
 * entity page or refuses with the pages it could mean (never a bare slug no
 * page carries), and a pending remember names its target page in the reply
 * and in a batch item. PGLite, synthetic names only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';

let engine: PGLiteEngine;
const sourceId = 'remember-target-7248';
const context = (overrides: Partial<OperationContext> = {}): OperationContext => ({ engine, remote: false, sourceId,
  config: { engine: 'pglite' }, dryRun: false, logger: { info() {}, warn() {}, error() {} }, ...overrides } as OperationContext);
const remember = (params: Record<string, unknown>, ctx = context()) =>
  operationsByName.remember!.handler(ctx, { provenance: 'chat 2026-10-21', infer_entity: false, ...params }) as Promise<Record<string, any>>;
async function refusal(params: Record<string, unknown>, ctx = context()): Promise<OperationError> {
  try { await remember(params, ctx); } catch (e) { if (e instanceof OperationError) return e; throw e; }
  throw new Error('remember was not refused');
}
async function putEntity(slug: string, title: string, type: string, frontmatter: Record<string, unknown> = {}) {
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () =>
    tx.putPage(slug, { type, title, compiled_truth: '# ' + title, frontmatter }, { sourceId }), TEST_WRITE_ATTRIBUTION));
}
const factRows = (fact: string) => engine.executeRaw<{ entity_slug: string | null }>('SELECT entity_slug FROM facts WHERE source_id=$1 AND fact=$2', [sourceId, fact]);

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await registerLocalWriter(engine, 'cli'); await registerLocalWriter(engine, 'stdio');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await putEntity('people/alice-example', 'Alice Example', 'person');
  await putEntity('people/alex-example', 'Alex Example', 'person');
  await putEntity('companies/alex-example', 'Alex Example Inc', 'company');
  await putEntity('companies/acme-example-labs', 'Acme Example Labs', 'company');
  await putEntity('companies/acme-example-capital', 'Acme Example Capital', 'company');
}, 60_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  resetGateway();
});

describe('remember: a folder-less entity names exactly one page (#7248)', () => {
  test('a unique basename and an exact display name resolve to the page and land in its fence', async () => {
    const a = await remember({ fact: 'Alice Example prefers tea', entity: 'alice-example' });
    expect(a).toMatchObject({ status: 'inserted', entity_slug: 'people/alice-example' });
    const b = await remember({ fact: 'Alice Example runs on Sundays', entity: 'Alice Example' });
    expect(b.entity_slug).toBe('people/alice-example');
    const page = (await engine.readPageSnapshot('people/alice-example', { sourceId }))!.page.compiled_truth;
    expect(page).toContain('Alice Example prefers tea');
    expect(page).toContain('Alice Example runs on Sundays');
  });

  test('a basename two pages share is refused with both, and nothing is saved', async () => {
    const e = await refusal({ fact: 'Alex Example closed the round', entity: 'alex-example' });
    expect(e.code).toBe('invalid_params');
    expect(e.reason).toBe('entity_ambiguous');
    expect(e.message).toContain('companies/alex-example, people/alex-example');
    expect(e.detail).toBe('candidates: companies/alex-example, people/alex-example');
    expect(e.suggestion).toContain('entity: "companies/alex-example"');
    expect(await factRows('Alex Example closed the round')).toEqual([]);
  });

  test('a first name that only begins a page is refused with that page, not guessed', async () => {
    const e = await refusal({ fact: 'Alice prefers window seats', entity: 'alice' });
    expect(e.reason).toBe('entity_unverified');
    expect(e.detail).toBe('candidates: people/alice-example');
    expect(await factRows('Alice prefers window seats')).toEqual([]);
  });

  test('a name with near pages but none its own is refused with them; a name nothing resembles saves under its slug as before', async () => {
    const e = await refusal({ fact: 'Acme Example hired a CFO', entity: 'acme-example' });
    expect(e.reason).toBe('entity_no_page');
    expect(e.message).toContain('companies/acme-example-capital, companies/acme-example-labs');
    expect(await factRows('Acme Example hired a CFO')).toEqual([]);
    const bare = await remember({ fact: 'Bob Example moved to Lisbon', entity: 'bob-example' });
    expect(bare).toMatchObject({ status: 'inserted', entity_slug: 'bob-example' });
    const saved = await remember({ fact: 'Bob Example moved to Porto', entity: 'people/bob-example' });
    expect(saved).toMatchObject({ status: 'inserted', entity_slug: 'people/bob-example' });
  });

  test('a remote caller is never told about a private page it cannot read', async () => {
    await putEntity('people/carol-example', 'Carol Example', 'person', { visibility: 'private' });
    const e = await refusal({ fact: 'Carol Example likes jazz', entity: 'carol-example' }, context({ remote: true }));
    expect(e.reason).toBe('entity_no_page');
    expect(e.detail).toBeUndefined();
    expect(e.message).not.toContain('people/carol-example');
    expect(await factRows('Carol Example likes jazz')).toEqual([]);
  });
});

describe('remember: a pending reply names its target page (#7248)', () => {
  test('the write_request carries target and the hint names the page', async () => {
    let pending: OperationError | null = null;
    try { await remember({ fact: 'Alice Example joined the board', entity: 'alice-example' }, context({ writeWaitMs: 0 })); } catch (e) { if (e instanceof OperationError) pending = e; else throw e; }
    expect(pending?.writeError).toBe('write_pending');
    const wire = pending!.toJSON() as Record<string, any>;
    expect(wire.write_request.target).toEqual({ slug: 'people/alice-example', entity_slug: 'people/alice-example' });
    expect(wire.suggestion).toContain('Its fact goes to page people/alice-example');
  });

  test('a batch reports a pending item as pending with its target, not failed', async () => {
    const out = await remember({ items: [{ fact: 'Alice Example speaks Portuguese', entity: 'people/alice-example' }, { fact: 'Alex Example ships weekly', entity: 'alex-example' }] },
      context({ writeWaitMs: 0 }));
    const [first, second] = out.items as Array<Record<string, any>>;
    expect(first).toMatchObject({ status: 'pending', target: { slug: 'people/alice-example', entity_slug: 'people/alice-example' } });
    expect(second).toMatchObject({ status: 'failed', error: { code: 'invalid_params' } });
    expect(out).toMatchObject({ saved: 0, failed: 1, pending: 1, partial: true });
  });
});
