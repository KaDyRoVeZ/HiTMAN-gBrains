import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../postgres15-sql-compat-7112.test.ts'));
