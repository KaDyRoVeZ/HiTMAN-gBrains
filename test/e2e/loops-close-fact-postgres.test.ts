import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../loops-close-fact.serial.test.ts'));
