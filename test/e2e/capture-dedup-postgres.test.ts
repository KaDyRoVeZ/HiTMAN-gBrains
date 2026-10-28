import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../capture-dedup.test.ts'));
