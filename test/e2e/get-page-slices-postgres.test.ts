import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../get-page-slices.test.ts'));
