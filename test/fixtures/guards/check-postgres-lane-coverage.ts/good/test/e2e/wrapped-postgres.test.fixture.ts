import { registerPostgresTests } from '../../../../../../helpers/test-backends.ts';

await registerPostgresTests(() => import('../wrapped.test.fixture.ts'));
