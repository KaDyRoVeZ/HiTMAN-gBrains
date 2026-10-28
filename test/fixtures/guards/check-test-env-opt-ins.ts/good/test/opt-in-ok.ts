import { describe, test } from 'bun:test';

// GBRAIN_TEST_* survives the scrub.
describe.skipIf(!process.env.GBRAIN_TEST_FIXTURE_COMPILE_SMOKE)('compiled smoke', () => {
  test('runs', () => {});
});

// A file that sets the name itself may gate on it.
process.env.GBRAIN_FIXTURE_SELF_SET = '1';
if (process.env.GBRAIN_FIXTURE_SELF_SET !== '1') throw new Error('unreachable');

// A product setting (read in src/) asserted absent is hermeticity, not an opt-in.
if (process.env.GBRAIN_FIXTURE_PRODUCT_SETTING === '1') throw new Error('product escape hatch is on');

// Non-gating reads are out of scope.
const budget = 100 * (Number(process.env.GBRAIN_FIXTURE_MULTIPLIER) || 1);
export { budget };
