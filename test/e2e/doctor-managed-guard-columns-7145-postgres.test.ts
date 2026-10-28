import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../doctor-managed-guard-columns-7145.test.ts'));
