/**
 * #5249: an accepted write still in flight is its own request-log class
 * (`accepted_pending`), never an `error`, and the admin health indicators
 * keep it out of the error rate while counting pending writes, their age and
 * those that later end without committing.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { acceptedPendingReceipt, dispatchToolCall, requestLogStatusForResult, type ToolResult } from '../src/mcp/dispatch.ts';
import { acquireWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { queryHealthIndicators } from '../src/commands/serve-http-admin-api.ts';
import { _resetWriteThroughCacheForTest } from '../src/core/write-through.ts';

const errorResult = (envelope: Record<string, unknown>): ToolResult => ({ isError: true, content: [{ type: 'text', text: JSON.stringify(envelope) }] });
const RID = '30000000-0000-4000-8000-000000000001';

describe('requestLogStatusForResult: accepted_pending (pure)', () => {
  test('a write_pending envelope with a non-terminal receipt is accepted_pending', () => {
    for (const state of ['queued', 'running', 'recovering']) {
      const result = errorResult({ error: 'write_pending', message: 'pending', write_request: { request_id: RID, state, retry_after_ms: 1000 } });
      expect(requestLogStatusForResult(result)).toBe('accepted_pending');
      expect(acceptedPendingReceipt(result)?.request_id).toBe(RID);
    }
  });
  test('the frozen verb shape (unavailable + write_error) is accepted_pending too', () => {
    expect(requestLogStatusForResult(errorResult({ error: 'unavailable', write_error: 'write_pending', protocol_version: 1,
      write_request: { request_id: RID, state: 'queued', retry_after_ms: 1000 } }))).toBe('accepted_pending');
  });
  test('without an admitted receipt, or with a terminal one, it stays an error', () => {
    expect(requestLogStatusForResult(errorResult({ error: 'write_pending', message: 'pending' }))).toBe('error');
    expect(requestLogStatusForResult(errorResult({ error: 'write_pending', write_request: { request_id: RID, state: 'failed', retry_after_ms: null } }))).toBe('error');
    expect(requestLogStatusForResult(errorResult({ error: 'unavailable', message: 'The persistence owner is closing.' }))).toBe('error');
    expect(acceptedPendingReceipt({ content: [{ type: 'text', text: '{}' }] })).toBeNull();
  });
});

let engine: PGLiteEngine;
let fixture: string;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
beforeEach(async () => {
  await disposePersistenceConsumer(engine);
  await resetPgliteState(engine);
  _resetWriteThroughCacheForTest();
  fixture = mkdtempSync(join(tmpdir(), 'gb-accepted-pending-'));
  mkdirSync(join(fixture, 'brain'));
  await engine.setConfig('sync.repo_path', join(fixture, 'brain'));
});

describe('a real pending write over the dispatcher', () => {
  test('dispatch with a short wait returns accepted_pending, and the health indicators exclude it from the error rate', async () => {
    await withEnv({ GBRAIN_HOME: join(fixture, 'home') }, async () => {
      const registration = await registerLocalWriter(engine, 'stdio', { sourceIds: ['*'], operations: null, scopes: ['read', 'write'], slugPrefixes: ['notes'] });
      const auth = { token: 'fixture', clientId: 'fixture-client', scopes: ['read', 'write'], sourceId: 'default', boundSlugPrefixes: ['notes'] };
      const put = (slug: string, writeWaitMs?: number) => withVerifiedLocalRegistration(engine, registration, () => dispatchToolCall(engine, 'put_page', {
        slug, content: `---\ntitle: Example\n---\n\n${slug} body.\n`, request_id: randomUUID(),
      }, { remote: true, config: { engine: 'pglite' }, sourceId: 'default', auth, logger: { info() {}, warn() {}, error() {} },
        ...(writeWaitMs !== undefined ? { writeWaitMs } : {}) }));
      try {
        expect(requestLogStatusForResult(await put('notes/seed'))).toBe('success');
        const binding = await getWorktreeBinding(engine, 'default');
        const lock = (await acquireWorktree(binding!))!;
        let pendingA: ToolResult, pendingB: ToolResult;
        try {
          const started = Date.now();
          pendingA = await put('notes/a', 200);
          pendingB = await put('notes/b', 200);
          expect(Date.now() - started).toBeLessThan(4_000);
        } finally { await lock.release(); }
        expect(requestLogStatusForResult(pendingA)).toBe('accepted_pending');
        expect(requestLogStatusForResult(pendingB)).toBe('accepted_pending');
        await disposePersistenceConsumer(engine);
        const a = acceptedPendingReceipt(pendingA)!, b = acceptedPendingReceipt(pendingB)!;
        await engine.executeRaw("UPDATE persistence_requests SET state='failed', error_code='storage_error' WHERE request_id=$1::uuid", [a.request_id]);
        const log = (status: string, params: Record<string, unknown> | null = null) => engine.executeRaw(
          'INSERT INTO mcp_request_log (token_name, operation, status, params) VALUES ($1, $2, $3, $4::jsonb)',
          ['fixture-client', 'put_page', status, params === null ? null : JSON.stringify(params)]);
        await log('success');
        await log('error');
        await log('denied_after_list');
        await log('accepted_pending', { write_request_id: a.request_id });
        await log('accepted_pending', { write_request_id: b.request_id });
        await engine.executeRaw("UPDATE persistence_requests SET created_at = now() - interval '90 seconds' WHERE request_id=$1::uuid", [b.request_id]);
        const health = await queryHealthIndicators(engine);
        expect(health.error_rate).toBe('40.0%');
        expect(health.pending_writes).toBe(1);
        expect(health.oldest_pending_write_age_seconds).toBeGreaterThanOrEqual(90);
        expect(health.pending_writes_later_failed).toBe(1);
      } finally { await disposePersistenceConsumer(engine); rmSync(fixture, { recursive: true, force: true }); }
    });
  }, 60_000);
});
