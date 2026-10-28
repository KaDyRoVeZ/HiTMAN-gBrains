import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../chronicle-auto-decision.test.ts'));
