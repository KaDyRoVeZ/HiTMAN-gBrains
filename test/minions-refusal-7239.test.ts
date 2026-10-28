/**
 * #7239: a deterministic refusal (an error whose registry code says the same request fails the same way again)
 * ends its job at once: one attempt, status dead, and the result names the refusal's code, reason and fix
 * (`job_outcome: 'refused'`). A transient failure (class retryable, server or unavailable, or a concurrency code)
 * still retries with backoff as before.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import { JobRefusedError, UnrecoverableError } from '../src/core/minions/errors.ts';
import { jobRefusal } from '../src/core/minions/refusal.ts';
import { encodeHandlerError, reconstructHandlerError } from '../src/core/minions/job-isolation.ts';
import { opError, OperationError } from '../src/core/ops/contract.ts';
import { CredentialError } from '../src/core/creds/errors.ts';
import { waitFor } from './helpers/wait-for.ts';
import { runSubagentsInline } from '../src/core/cycle/inline-drain.ts';

const writerStatusFix = { argv: ['gbrain', 'sources', 'writer', 'status', '--source', 'source-a', '--json'], consent: [], actor: 'agent' as const, requires_exclusive: false, why: 'Read-only.' };
const managedRefusal = () => opError('writer_coordinator_required', 'Managed sync requires skipping the Git pull.', 'Sync with --no-pull.', { fix: writerStatusFix });

describe('#7239 jobRefusal', () => {
  test('a caller, consent or host_only code that is not retryable is a refusal, with its code and fix', () => {
    const r = jobRefusal(managedRefusal());
    expect(r).toMatchObject({ code: 'writer_coordinator_required', message: 'Managed sync requires skipping the Git pull.', docs_cmd: ['gbrain', 'errors', 'writer_coordinator_required'] });
    expect((r!.fix as { command?: string; argv?: string[] }).argv ?? (r!.fix as { command?: string }).command).toBeTruthy();
    expect(jobRefusal(opError('connector_account_changed', 'Connector source source-a is pinned to a different account.', 'x'))?.code).toBe('connector_account_changed');
    expect(jobRefusal(new CredentialError('not_connected', ' for alice-example'))?.code).toBe('not_connected');
  });

  test('the suggestion never rides the refusal: job rows are served remotely and a suggestion may name an account', () => {
    const r = jobRefusal(opError('connector_account_changed', 'Connector source source-a is pinned to a different account.', 'pinned to alice@example.com'));
    expect(JSON.stringify(r)).not.toContain('alice@example.com');
  });

  test('a site that marks its error retryable: false is a refusal whatever the class; retryable: true never is', () => {
    expect(jobRefusal(opError('owner_unavailable', 'Sync must run on the active registered worktree owner.', 'x', { reason: 'host_mismatch', retryable: false }))).toMatchObject({ code: 'owner_unavailable', reason: 'host_mismatch' });
    expect(jobRefusal(opError('writer_coordinator_required', 'm', 's', { retryable: true }))).toBeNull();
  });

  test('transient classes, concurrency codes, unregistered codes and plain errors are not refusals', () => {
    expect(jobRefusal(opError('owner_unavailable', 'Sync must run on the active registered worktree owner.', 'x'))).toBeNull();
    expect(jobRefusal(opError('write_pending', 'The write is accepted and is still pending.', 'x'))).toBeNull();
    expect(jobRefusal(opError('storage_error', 'disk', 'x'))).toBeNull();
    expect(jobRefusal(opError('unavailable', 'no key', 'x'))).toBeNull();
    expect(jobRefusal(opError('revision_conflict', 'moved', 'x'))).toBeNull();
    expect(jobRefusal(opError('concurrent_write', 'moved', 'x'))).toBeNull();
    expect(jobRefusal(new OperationError('not_a_registered_code_7239', 'm'))).toBeNull();
    expect(jobRefusal(new Error('boom'))).toBeNull();
    expect(jobRefusal(new UnrecoverableError('dead anyway'))).toBeNull();
  });

  test('a refusal wrapped as an error cause is still found', () => {
    expect(jobRefusal(new Error('sync failed', { cause: managedRefusal() }))?.code).toBe('writer_coordinator_required');
  });

  test('a refusal crosses the per-job child boundary intact (process isolation)', () => {
    const encoded = encodeHandlerError(managedRefusal());
    expect(encoded).toMatchObject({ outcome: 'error', errorKind: 'refused' });
    const rebuilt = reconstructHandlerError(JSON.parse(JSON.stringify(encoded)));
    expect(rebuilt).toBeInstanceOf(JobRefusedError);
    expect(jobRefusal(rebuilt)).toEqual(jobRefusal(managedRefusal()));
  });
});

describe('#7239 worker ends a refused job at once', () => {
  let engine: PGLiteEngine;
  let queue: MinionQueue;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
    queue = new MinionQueue(engine);
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await engine.executeRaw('DELETE FROM minion_jobs'); });

  async function runOne(name: string, fail: () => Error, until: (status: string) => boolean) {
    const job = await queue.add(name, {}, { max_attempts: 3, backoff_type: 'fixed', backoff_delay: 60_000 });
    const worker = new MinionWorker(engine, { pollInterval: 25 });
    let calls = 0;
    worker.register(name, async () => { calls++; throw fail(); });
    const running = worker.start();
    try {
      await waitFor(async () => until((await queue.getJob(job.id))?.status ?? ''), { timeoutMs: 10_000, label: `${name} settled` });
    } finally {
      worker.stop();
      await running;
    }
    return { job: (await queue.getJob(job.id))!, calls };
  }

  test('a deterministic refusal is dead after one attempt, with the refusal on the result', async () => {
    const { job, calls } = await runOne('sync', managedRefusal, s => s === 'dead');
    expect(calls).toBe(1);
    expect(job.attempts_made).toBe(1);
    expect(job.error_text).toBe('Managed sync requires skipping the Git pull.');
    expect(job.result).toMatchObject({ job_outcome: 'refused', refusal: { code: 'writer_coordinator_required', docs_cmd: ['gbrain', 'errors', 'writer_coordinator_required'] } });
  });

  test('a transient failure still retries with backoff (not dead after one attempt)', async () => {
    const { job, calls } = await runOne('sync', () => opError('write_pending', 'The write is accepted and is still pending.', 'x'), s => s === 'delayed');
    expect(calls).toBe(1);
    expect(job.status).toBe('delayed');
    expect(job.attempts_made).toBe(1);
    expect(job.result).toBeNull();
  });
});

describe('#7239 the dream inline drain ends a refused child at once', () => {
  let engine: PGLiteEngine;
  let queue: MinionQueue;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ database_url: '' });
    await engine.initSchema();
    queue = new MinionQueue(engine);
  });
  afterAll(async () => { await engine.disconnect(); });

  test('one handler call, dead, refusal on the result', async () => {
    const child = await queue.add('subagent', { prompt: 'p' }, { queue: 'dream-inline-7239-a', max_attempts: 3 }, { allowProtectedSubmit: true });
    let calls = 0;
    await runSubagentsInline(engine, queue, 'dream-inline-7239-a', undefined, async () => { calls++; throw managedRefusal(); });
    const row = (await queue.getJob(child.id))!;
    expect(calls).toBe(1);
    expect(row.status).toBe('dead');
    expect(row.result).toMatchObject({ job_outcome: 'refused', refusal: { code: 'writer_coordinator_required' } });
  });
});
