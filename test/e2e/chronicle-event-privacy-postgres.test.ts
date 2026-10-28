import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../chronicle-event-privacy.test.ts'));
