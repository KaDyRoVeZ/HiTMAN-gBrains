/**
 * GBRA-156: an unscoped remote read that reaches no source holding a page,
 * while pages sit in sources the connection cannot read, says so.
 *
 * 1. Protects: a token with no source grant reads the default source plus the
 *    federated ones. A new source is not federated by default, so a brain
 *    whose pages all live in such sources answered every search with `[]`
 *    and an `empty_retrieval` notice calling it a clean miss. The read now
 *    carries a `sources_not_readable` notice whose fix is the host command
 *    that makes the pages readable (federate the source, or grant the
 *    connection), without naming any source the connection cannot read.
 * 2. Fails when: the notice is missing on an empty unscoped read whose scope
 *    holds no page, it names a hidden source, it fires on a real miss inside
 *    a scope that holds pages, or it fires for a connection whose operator
 *    granted it sources (a token granted sources, or an OAuth client).
 * 3. Existing coverage: `source_binding_narrowed` covers a bound stdio
 *    connection only (mcp-notice-channels).
 * 4. No production seam: production serve-http app, real tokens.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { callTool, clientCredentialsToken, legacyToken, ownerCookie, registerOAuthClient, startServeHttp, type LiveServeHttp, type ToolResultWire } from './helpers/live-mcp-servers.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const HIDDEN = 'source-hidden';
const CANARY = 'harbourcanary';
const QUERY = 'quillmarsh ledger';

function noticeBlock(result: ToolResultWire, code: string): string | undefined {
  return result.content.map(c => c.text).find(t => t.startsWith(`[gbrain notice ${code} `));
}

function rows(result: ToolResultWire): unknown {
  return JSON.parse(result.content[0]!.text);
}

for (const kind of testBackends()) {
  describe(`sources_not_readable notice (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let serve: LiveServeHttp;
    let noGrant: string;
    let granted: string;
    let oauth: string;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $1), ('source-empty', 'source-empty') ON CONFLICT (id) DO NOTHING`, [HIDDEN]);
      await importFromContent(engine, 'notes/quillmarsh-ledger', `# Ledger\nThe quillmarsh ledger for the harbour team, ${CANARY}.`, { sourceId: HIDDEN, noEmbed: true });
      serve = await startServeHttp(engine, { surface: 'full' });
      noGrant = await legacyToken(engine, ['read']);
      granted = (await mintLegacyToken(engine, { name: 'granted-empty', takesHolders: ['world'], scopes: ['read'], sourceGrant: ['source-empty'] })).token;
      const client = await registerOAuthClient(serve, await ownerCookie(serve), 'read');
      oauth = await clientCredentialsToken(serve, client.clientId, client.clientSecret, 'read');
    }, 180_000);

    afterAll(async () => {
      await serve?.close();
      await close?.();
    }, 60_000);

    for (const [tool, args] of [
      ['search', { query: QUERY }],
      ['search', { query: QUERY, match: 'keyword' }],
      ['query', { query: QUERY, expand: false }],
      ['list_pages', {}],
      ['recall', { query: QUERY }],
    ] as const) {
      test(`${tool} ${JSON.stringify(args)}: a no-grant token whose sources hold no page is told the pages are elsewhere`, async () => {
        const out = await callTool(serve.base, noGrant, tool, args);
        expect(out.isError).not.toBe(true);
        expect(JSON.stringify(out.content)).not.toContain(CANARY);
        const block = noticeBlock(out, 'sources_not_readable');
        expect(block).toBeDefined();
        expect(block).toContain('kind=degraded');
        expect(block).toContain('gbrain sources federate');
        expect(block).not.toContain(HIDDEN);
      }, 60_000);
    }

    test('an OAuth client always carries a grant (at least its bound source), so it gets no notice', async () => {
      const out = await callTool(serve.base, oauth, 'search', { query: QUERY });
      expect(rows(out)).toEqual([]);
      expect(noticeBlock(out, 'sources_not_readable')).toBeUndefined();
    }, 60_000);

    test('a token the operator granted a source gets no notice (its scope is deliberate)', async () => {
      const out = await callTool(serve.base, granted, 'search', { query: QUERY });
      expect(rows(out)).toEqual([]);
      expect(noticeBlock(out, 'sources_not_readable')).toBeUndefined();
    }, 60_000);

    test('naming a source explicitly gets no notice', async () => {
      const out = await callTool(serve.base, noGrant, 'search', { query: QUERY, source_id: 'default' });
      expect(rows(out)).toEqual([]);
      expect(noticeBlock(out, 'sources_not_readable')).toBeUndefined();
    }, 60_000);

    test('once the source is federated the same token reads the page, and a real miss carries no notice', async () => {
      await engine.executeRaw(`UPDATE sources SET config = COALESCE(config, '{}'::jsonb) || '{"federated": true}'::jsonb WHERE id = $1`, [HIDDEN]);
      try {
        const hit = await callTool(serve.base, noGrant, 'search', { query: QUERY });
        expect(JSON.stringify(rows(hit))).toContain('quillmarsh-ledger');
        const miss = await callTool(serve.base, noGrant, 'search', { query: 'zzyzx nothing matches this' });
        expect(rows(miss)).toEqual([]);
        expect(noticeBlock(miss, 'sources_not_readable')).toBeUndefined();
      } finally {
        await engine.executeRaw(`UPDATE sources SET config = config - 'federated' WHERE id = $1`, [HIDDEN]);
      }
    }, 60_000);
  });
}
