import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../read-waves-gbra133.test.ts'));
