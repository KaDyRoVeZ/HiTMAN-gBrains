/**
 * Router as a security boundary: no operation accepts query-language text,
 * and query text sent by a remote caller through the retrieval and graph ops
 * is only ever data. SQL and graph-query injection strings leave every page
 * and link in place and come back as ordinary result envelopes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations } from '../src/core/operations.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { withEnv } from './helpers/with-env.ts';

const RAW_QUERY_PARAM = /^(sql|cypher|query_sql|statement|raw_query|raw_sql|gql|sparql)$/i;
const PAYLOADS = [
  "'; DROP TABLE pages; --",
  'MATCH (n) DETACH DELETE n',
  '$1) OR 1=1 --',
  "x' UNION SELECT token FROM access_tokens --",
];
const REMOTE = { remote: true, transport: 'http' as const, sourceId: 'default' };

let engine: PGLiteEngine;

async function counts(): Promise<{ pages: number; links: number }> {
  const [p] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages');
  const [l] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM links');
  return { pages: Number(p!.n), links: Number(l!.n) };
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: 'A company.' });
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Works at Acme.' });
  await engine.addLink('people/alice-example', 'companies/acme-example', '', 'works_at', 'manual');
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('raw-query routing guard', () => {
  test('no operation declares a query-language parameter', () => {
    const offenders = operations.flatMap(op => Object.keys(op.params).filter(k => RAW_QUERY_PARAM.test(k)).map(k => `${op.name}.${k}`));
    expect(offenders).toEqual([]);
  });

  test('injection text through search, query, recall and traverse_graph is inert for a remote caller', async () => {
    const before = await counts();
    for (const payload of PAYLOADS) {
      const calls: Array<[string, Record<string, unknown>]> = [
        ['search', { query: payload }],
        ['query', { query: payload, expand: false }],
        ['recall', { query: payload }],
        ['traverse_graph', { slug: payload }],
        ['traverse_graph', { slug: 'people/alice-example', link_type: payload }],
      ];
      for (const [name, args] of calls) {
        const res = await withEnv({ GBRAIN_BACKUP_CHECK: '0' }, () => dispatchToolCall(engine, name, args, REMOTE));
        expect(Array.isArray(res.content)).toBe(true);
      }
    }
    expect(await counts()).toEqual(before);
  });
});
