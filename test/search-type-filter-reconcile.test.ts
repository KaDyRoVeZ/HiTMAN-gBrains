/**
 * Agents guess page types a brain does not have. A `types` filter naming only
 * missing types is lifted and the model is told which types exist; a filter
 * mixing real and missing types keeps the real ones and says so. Found by
 * gbrain-evals Cat 40, where type-filtered agent runs failed more often.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializeMarkdown } from '../src/core/markdown.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  const pages = [
    ['contracts/wombat-msa', 'contract', 'wombat master services agreement payment terms net 45'],
    ['contracts/wombat-amendment', 'amendment', 'wombat amendment changes payment terms to net 30'],
    ['crm/wombat', 'crm', 'wombat account record owner and billing contact'],
  ] as const;
  for (const [slug, type, body] of pages) {
    const r = await importFromContent(engine, slug, serializeMarkdown({}, body, '', { type, title: slug, tags: [] }), { noEmbed: true, forceRechunk: true });
    expect(r.status).toBe('imported');
  }
}, 120_000);

afterAll(async () => { await engine?.disconnect(); });

const call = (args: Record<string, unknown>) => dispatchToolCall(engine, 'search', args, { remote: true, transport: 'http', sourceId: 'default' });
const slugsOf = (r: { content: Array<{ text?: string }> }) => (JSON.parse(r.content[0].text!) as Array<{ slug: string }>).map(x => x.slug);
const notices = (r: { content: Array<{ text?: string }> }) => r.content.slice(1).map(c => c.text ?? '');

describe('search type filter reconciliation', () => {
  test('only-missing types: the filter is lifted and the existing types are named', async () => {
    const r = await call({ query: 'wombat payment terms', types: ['company', 'account'] });
    expect(slugsOf(r)).toContain('contracts/wombat-amendment');
    const text = notices(r).join('\n');
    expect(text).toContain('No pages have type company, account');
    expect(text).toContain('amendment, contract, crm');
  });

  test('mixed types: real types stay applied and the missing one is reported', async () => {
    const r = await call({ query: 'wombat payment terms', types: ['contract', 'company'] });
    const slugs = slugsOf(r);
    expect(slugs).toContain('contracts/wombat-msa');
    expect(slugs).not.toContain('contracts/wombat-amendment');
    expect(notices(r).join('\n')).toContain('filtered to contract');
  });

  test('existing types only: no notice', async () => {
    const r = await call({ query: 'wombat payment terms', types: ['amendment'] });
    expect(slugsOf(r)).toEqual(['contracts/wombat-amendment']);
    expect(notices(r).some(t => t.includes('No pages have type'))).toBe(false);
  });
});
