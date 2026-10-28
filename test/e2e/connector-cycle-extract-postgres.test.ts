import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../connector-cycle-extract.test.ts'));
