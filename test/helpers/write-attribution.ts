import type { WriteAttribution } from '../../src/core/persistence/attribution.ts';

/** The actor test fixtures name when they write through withCoordinatedWrite directly. */
export const TEST_WRITE_ATTRIBUTION: WriteAttribution = { requestId: null, principal: { kind: 'application', id: 'test:fixture' } };
