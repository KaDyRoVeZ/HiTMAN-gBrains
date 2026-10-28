import { describe } from 'bun:test';
import { testBackends } from '../../../../../helpers/test-backends.ts';

for (const backend of testBackends()) describe(backend, () => {});
