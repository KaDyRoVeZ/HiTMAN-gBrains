import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../coordinated-write-commit-gbra133.test.ts'));
