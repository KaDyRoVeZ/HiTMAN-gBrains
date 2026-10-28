/** Dependency-free handler errors, shared by policy and worker entrypoints. */

/** Throw this from a handler to skip all retry logic and go straight to 'dead'. */
export class UnrecoverableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableError';
  }
}

/**
 * Throw this from a handler when the job cannot run yet for a reason outside
 * the job itself (no provider key, a spend budget used up, shutdown). The
 * worker returns the job to `delayed` for `retryInMs` WITHOUT counting an
 * attempt, so the work waits instead of failing or completing empty.
 */
export class JobDeferredError extends Error {
  constructor(readonly reason: string, message: string, readonly retryInMs: number) {
    super(message);
    this.name = 'JobDeferredError';
  }
}

/**
 * #7239: a deterministic refusal, recorded on the job's result as `refusal` (job_outcome `refused`). `fix` is the
 * error's rendered next step and `docs_cmd` explains the code offline; the suggestion prose is never kept, because job
 * rows are served to remote callers and a suggestion may name an account or a local path.
 */
export interface JobRefusal {
  code: string;
  reason?: string;
  message: string;
  fix?: unknown;
  docs_cmd: string[];
}

/** A refusal rebuilt on the worker side of a per-job child (job-isolation.ts); terminal like any UnrecoverableError. */
export class JobRefusedError extends UnrecoverableError {
  constructor(readonly refusal: JobRefusal) {
    super(refusal.message);
    this.name = 'JobRefusedError';
  }
}
