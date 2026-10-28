/**
 * The process-level queue for the first `chat_fallback_chain` hop's
 * `chat_fallback_hop` safety notice. `chatWithFallback` queues at most one
 * per process; MCP dispatch (stdio), the CLI op notice channel and CLI
 * teardown drain it. No imports beyond a type, so every drain site can load
 * it cheaply.
 */
import type { Notice } from '../agent-output.ts';

/** One process's (or one warm CLI request's) first-hop state. */
export interface FallbackHopQueue { queued: boolean; pending: Notice[] }

const processQueue: FallbackHopQueue = { queued: false, pending: [] };
let hopScope: (() => FallbackHopQueue | undefined) | undefined;

/**
 * A serve answering warm CLI requests (src/core/cli-socket/output-capture.ts)
 * gives each request its own queue, as a one-shot CLI process starts with one;
 * outside a scope the process queue applies.
 */
export function setFallbackHopScope(scope: () => FallbackHopQueue | undefined): void {
  hopScope = scope;
}

function activeQueue(): FallbackHopQueue {
  return hopScope?.() ?? processQueue;
}

/** Queue the first hop's notice; every later call in this process is a no-op. Returns whether it queued. */
export function queueFirstFallbackHop(build: () => Notice): boolean {
  const queue = activeQueue();
  if (queue.queued) return false;
  queue.queued = true;
  queue.pending.push(build());
  return true;
}

/** Drain the queued first-hop notice (at most one per process). */
export function takeChatFallbackHopNotices(): Notice[] {
  return activeQueue().pending.splice(0);
}

/** Test seam: re-arm the once-per-process first-hop notice. */
export function __resetChatFallbackHopNoticeForTests(): void {
  processQueue.queued = false;
  processQueue.pending.splice(0);
}
