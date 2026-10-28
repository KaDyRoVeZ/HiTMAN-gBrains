/**
 * #7239: is a handler's error a deterministic refusal, one that fails the same way on every retry? The worker and the
 * dream inline drain end such a job at once (dead, one attempt) with the refusal on its result instead of burning its
 * retries; autopilot's freshness dispatch then backs off the source (autopilot-dispatch.ts).
 *
 * The error's registry code decides (error-registry.ts): a site that set `retryable` wins; otherwise a code whose class
 * is caller, consent or host_only and that the registry does not mark retryable is a refusal. Classes retryable, server
 * and unavailable stay retryable (a dependency can come back), so do the concurrency codes a re-read can clear, codes the
 * registry does not know, and errors with no code. An error with no code is looked through to its `cause`.
 */
import { JobRefusedError, UnrecoverableError, type JobRefusal } from './errors.ts';
import { OperationError } from '../ops/contract.ts';
import { codeClass, codeRetryable, isRegistryCode } from '../error-catalogue.ts';

const DETERMINISTIC_CLASSES = new Set(['caller', 'consent', 'host_only']);
const CONCURRENCY_CODES = new Set(['revision_conflict', 'page_identity_changed', 'concurrent_write']);

export function jobRefusal(err: unknown): JobRefusal | null {
  let e: unknown = err;
  for (let depth = 0; e instanceof Error && depth < 4; depth++, e = e.cause) {
    if (e instanceof JobRefusedError) return e.refusal;
    if (e instanceof UnrecoverableError) return null;
    const fields = e as { code?: unknown; reason?: unknown; retryable?: unknown };
    const code = e instanceof OperationError ? e.canonicalCode : fields.code;
    if (typeof code !== 'string') continue;
    const reason = typeof fields.reason === 'string' ? fields.reason : undefined;
    if (!isRegistryCode(code) || fields.retryable === true) return null;
    const refused = fields.retryable === false
      || (DETERMINISTIC_CLASSES.has(codeClass(code, reason)) && !codeRetryable(code, reason) && !CONCURRENCY_CODES.has(code));
    if (!refused) return null;
    const fix = e instanceof OperationError && e.fix ? e.toJSON().fix : undefined;
    return { code, ...(reason !== undefined ? { reason } : {}), message: e.message, ...(fix !== undefined ? { fix } : {}), docs_cmd: ['gbrain', 'errors', code] };
  }
  return null;
}

/** The result a refused job stores. */
export function refusedJobResult(refusal: JobRefusal): Record<string, unknown> {
  return { job_outcome: 'refused', refusal };
}
