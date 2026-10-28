import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../session-seat-synthesize.test.ts'));
