import { describe, test } from 'bun:test';

// A stripped GBRAIN_* opt-in read straight in describe.skipIf: the preload
// deletes it, so the suite can never run.
describe.skipIf(!process.env.GBRAIN_FIXTURE_COMPILE_SMOKE)('compiled smoke', () => {
  test('runs', () => {});
});
