/**
 * Engine graduation crash custody (PGLite -> Postgres 16).
 *
 * Protects: "exactly one authoritative engine at every instant, across
 * crashes" (plan §3.3, §6.2, §13). The real CLI run is SIGKILLed at every
 * custody boundary it announces (quiesce, drain, fence, mid-table and
 * table-boundary copy, verify, each cutover sub-step, around the routing flip)
 * and at every rollback substep. After each kill: no instant with two
 * writable engines; `--status` reports without mutating; a clean process with
 * no target environment variable resumes from the 0600 manifest; the end
 * state is graduated (or rolled back) with every expected.json expectation,
 * one row per request id, the queued request replaying its stored outcome,
 * and a green target doctor.
 * Regressions it catches: a step whose durable write is not ordered before
 * its effect (e.g. tombstone before rename, authority before tombstone),
 * reconciliation that restarts from routing instead of the manifest, a
 * resume that re-runs terminal requests, a rollback that strands the live
 * brain or restores authority after approval.
 * Not covered elsewhere: the orchestrator's unit tests run in-process without
 * kills. Production seam: `graduationBoundary()` hooks, inert unless the
 * crash preload registers them.
 * Split across graduation-crash-run-{1,2,3} and graduation-crash-rollback-{1,2}
 * (test/helpers/graduation-crash-cases.ts) so CI can run them side by side;
 * this file kills the first run boundaries.
 * Runtime: about 16 s per case.
 */
import { afterAll } from 'bun:test';
import { closeCases, RUN_KILLS, runKillSuite } from '../helpers/graduation-crash-cases.ts';

afterAll(closeCases);

runKillSuite(RUN_KILLS.slice(0, 6));
