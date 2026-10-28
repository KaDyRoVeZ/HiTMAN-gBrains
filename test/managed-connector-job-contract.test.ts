/**
 * E10 managed connector-source job contract, PGLite lane. The cases, the
 * detector and the per-issue expected failures live in
 * test/helpers/managed-connector-job-contract.ts; the PostgreSQL twin is
 * test/e2e/managed-connector-job-contract.test.ts.
 *
 * Authoring gate. (1) Protects every automatic maintenance job on an unbound
 * connector source of a managed brain: it does real work through the
 * coordinator, is never refused by managed_writer_guard, reports what
 * committed and never dead-letters. (2) Fails when a sibling writer bypasses
 * the coordinator or misreports its outcome (#5856, #5867, #5869, #5875,
 * #5904 probe, #5854). (3) Existing connector tests mock runCycle or drive
 * one writer at a time on bound sources. (4) No production seam.
 */
import { afterAll, beforeAll, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { contractCases, exerciseConnectorJobContract, POSTGRES_ONLY_CASES, setupContractBrain, teardownContractBrain, type ContractBrain } from './helpers/managed-connector-job-contract.ts';

let engine: PGLiteEngine;
let brain: ContractBrain | undefined;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  brain = await setupContractBrain(engine);
}, 120_000);
afterAll(async () => {
  await teardownContractBrain(brain);
  await engine.disconnect();
});

for (const id of contractCases) {
  if (POSTGRES_ONLY_CASES.has(id)) continue;
  test(`managed connector job contract: ${id}`, () => exerciseConnectorJobContract(brain!, id), 180_000);
}
