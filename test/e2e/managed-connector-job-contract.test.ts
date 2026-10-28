/**
 * E10 managed connector-source job contract, PostgreSQL lane: the same cases
 * as test/managed-connector-job-contract.test.ts against pgvector Postgres,
 * plus the cases that need a second connection or the Postgres-only atom
 * auto-drain dispatch. Cases, detector and expected failures:
 * test/helpers/managed-connector-job-contract.ts.
 */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { contractCases, exerciseConnectorJobContract, setupContractBrain, teardownContractBrain, type ContractBrain } from '../helpers/managed-connector-job-contract.ts';

(process.env.DATABASE_URL ? describe : describe.skip)('managed connector job contract (PostgreSQL)', () => {
  let fixture: Awaited<ReturnType<typeof isolatedPersistencePostgres>> | undefined;
  let brain: ContractBrain | undefined;
  beforeAll(async () => {
    fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    brain = await setupContractBrain(fixture.engine);
  }, 120_000);
  afterAll(async () => {
    await teardownContractBrain(brain);
    await fixture?.close();
  });
  for (const id of contractCases) test(id, () => exerciseConnectorJobContract(brain!, id), 180_000);
});
