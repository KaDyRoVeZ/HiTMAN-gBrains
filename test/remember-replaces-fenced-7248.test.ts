/**
 * #7248 follow-up: `remember --replaces` on a fact that lives in an owner
 * page's `## Facts` fence (imported from the page, not written by remember).
 * A private fenced fact answered not_found to a local caller that left
 * visibility unset, because the default (world) never matched it. The
 * replacement now keeps a private target private; an explicit mismatch names
 * itself instead of claiming the fact is missing; a remote caller still gets
 * not_found for a private fact.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

let engine: PGLiteEngine;
const SLUG = 'people/alice-example';
const HEADER = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n';
const PAGE = '---\ntitle: Alice Example\ntype: person\n---\n# Alice Example\n\nA person.\n\n## Facts\n\n<!--- gbrain:facts:begin -->\n\n' + HEADER
  + '| 1 | Alice Example works at acme-example. | fact | 1.0 | world | medium | 2026-10-01T00:00:00Z |  | test |  |\n'
  + '| 2 | Alice Example likes tea. | preference | 1.0 | private | medium | 2026-10-01T00:00:00Z |  | test |  |\n'
  + '<!--- gbrain:facts:end -->\n';

async function call(name: string, params: Record<string, unknown>, remote = false) {
  const res = await dispatchToolCall(engine, name, params, remote
    ? { remote: true, takesHoldersAllowList: ['world'], sourceId: 'default' } : { remote: false });
  return { isError: res.isError === true, body: JSON.parse(res.content[0]!.text!) as Record<string, any> };
}
async function fenced(claim: string) {
  const [row] = await engine.executeRaw<{ id: number; row_num: number; visibility: string }>(
    'SELECT id, row_num, visibility FROM facts WHERE source_markdown_slug = $1 AND fact = $2', [SLUG, claim]);
  return row!;
}
async function factRow(id: number | string) {
  const [r] = await engine.executeRaw<{ visibility: string; expired: boolean; superseded_by: number | null }>(
    'SELECT visibility, expired_at IS NOT NULL AS expired, superseded_by FROM facts WHERE id = $1', [Number(id)]);
  return r!;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await disposePersistenceConsumer(engine); resetGateway(); __setEmbedTransportForTests(null); await engine.disconnect(); });
beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  const put = await call('put_page', { slug: SLUG, content: PAGE });
  expect(put.isError).toBe(false);
});

describe('remember replaces a fenced fact (#7248)', () => {
  test('the imported fence rows are active facts with row numbers', async () => {
    expect(await fenced('Alice Example works at acme-example.')).toMatchObject({ row_num: 1, visibility: 'world' });
    expect(await fenced('Alice Example likes tea.')).toMatchObject({ row_num: 2, visibility: 'private' });
  });

  test('a world fenced fact is replaced', async () => {
    const old = await fenced('Alice Example works at acme-example.');
    const res = await call('remember', { fact: 'Alice Example left acme-example.', provenance: 'test', entity: SLUG, replaces: String(old.id) });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ status: 'superseded', superseded_fact_id: String(old.id), replaced_by_caller: true });
    expect(await factRow(old.id)).toEqual({ visibility: 'world', expired: true, superseded_by: Number(res.body.id) });
  });

  test('a private fenced fact is replaced without passing visibility, and the replacement stays private', async () => {
    const old = await fenced('Alice Example likes tea.');
    const res = await call('remember', { fact: 'Alice Example likes coffee.', provenance: 'test', entity: SLUG, replaces: String(old.id) });
    expect(res.isError).toBe(false);
    expect(res.body).toMatchObject({ status: 'superseded', superseded_fact_id: String(old.id) });
    expect(await factRow(res.body.id)).toMatchObject({ visibility: 'private', expired: false });
    expect(await factRow(old.id)).toEqual({ visibility: 'private', expired: true, superseded_by: Number(res.body.id) });
    const page = await call('get_page', { slug: SLUG, include_content: true });
    const content = String(page.body.content ?? page.body.compiled_truth);
    expect(content).toContain('superseded by #' + res.body.id);
    expect(content).toMatch(/\| Alice Example likes coffee\. \| [a-z]+ \| [0-9.]+ \| private \|/);
  });

  test('an explicit visibility that differs names the mismatch instead of claiming the fact is missing', async () => {
    const old = await fenced('Alice Example likes tea.');
    const res = await call('remember', { fact: 'Alice Example likes coffee.', provenance: 'test', entity: SLUG, replaces: String(old.id), visibility: 'world' });
    expect(res.isError).toBe(true);
    expect(res.body.code).toBe('invalid_params');
    expect(res.body.message).toContain('replaces_visibility_mismatch');
    expect(res.body.suggestion).toContain('visibility: "private"');
    expect(await factRow(old.id)).toMatchObject({ expired: false, superseded_by: null });
  });

  test('a remote caller still gets not_found for a private fenced fact', async () => {
    const old = await fenced('Alice Example likes tea.');
    const res = await call('remember', { fact: 'Alice Example likes coffee.', provenance: 'test', entity: SLUG, replaces: String(old.id) }, true);
    expect(res.isError).toBe(true);
    expect(res.body.code).toBe('not_found');
    expect(JSON.stringify(res.body)).not.toContain('private');
    expect(await factRow(old.id)).toMatchObject({ expired: false, superseded_by: null });
  });
});
