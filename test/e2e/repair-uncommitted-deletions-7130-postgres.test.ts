import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../repair-uncommitted-deletions-7130.test.ts'));
