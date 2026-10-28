import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../maintenance-write-wait.test.ts'));
