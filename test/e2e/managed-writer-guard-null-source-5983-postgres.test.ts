import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../managed-writer-guard-null-source-5983.test.ts'));
