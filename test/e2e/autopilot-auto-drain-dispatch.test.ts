import { registerPostgresTests } from '../helpers/test-backends.ts';

await registerPostgresTests(() => import('../autopilot-auto-drain-dispatch.test.ts'));
