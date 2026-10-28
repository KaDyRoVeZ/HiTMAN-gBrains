import { describe } from 'bun:test';
import { writeContractConformanceCases } from '../fixtures/write-contract-conformance-cases.ts';

// O-CEO-13 on Postgres (isolated database per case); the PGLite run is test/write-contract-conformance.test.ts.
const databaseUrl = process.env.GBRAIN_DATABASE_URL || process.env.DATABASE_URL;
(databaseUrl ? describe : describe.skip)('isolated Postgres write contract conformance', () => {
  writeContractConformanceCases(databaseUrl);
});
