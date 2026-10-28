import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../doctor-capped-counts-7145.test.ts'));
