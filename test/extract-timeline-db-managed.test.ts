/**
 * #5904 probe (E28): `extract timeline --source db` on a managed PGLite brain.
 * Postgres arm: test/e2e/extract-timeline-db-postgres.test.ts.
 */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { prepareTimelineExtract } from '../src/commands/extract-timeline-db.ts';
import { caught, envelopeFor } from './helpers/agent-envelope.ts';
import { managedTimelineDbRefusalExitsNonZero, managedTimelineDbWritesThroughCoordinator } from './helpers/extract-timeline-db-scenarios.ts';

test('managed extract timeline --source db writes the missing rows through the coordinator', () => managedTimelineDbWritesThroughCoordinator(), 120_000);
test('a refused timeline write says nothing was written and exits non-zero', () => managedTimelineDbRefusalExitsNonZero(), 120_000);

test('a page replaced before its queued extraction reads the current page, on the CLI and over MCP', async () => {
  const engine = { readPageSnapshot: async () => null } as unknown as BrainEngine;
  const row = { slug: 'people/alice-example', source_id: 'notes', page_id: '7' } as unknown as WriteRequest;
  const error = await caught(() => prepareTimelineExtract(engine, row));
  expect(envelopeFor(error)).toMatchObject({ code: 'page_identity_changed',
    fix: { argv: ['gbrain', 'get', '--source', 'notes', '--', 'people/alice-example'], next: 'run' } });
  expect(envelopeFor(error, 'stdio', ['get_page']).fix).toMatchObject({ mcp: { tool: 'get_page', arguments: { slug: 'people/alice-example', source_id: 'notes' } }, next: 'run' });
});
