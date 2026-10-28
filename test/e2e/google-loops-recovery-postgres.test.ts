import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../google-loops-recovery.serial.test.ts'));
