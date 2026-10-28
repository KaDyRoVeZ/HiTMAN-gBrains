import { describe, test } from 'bun:test';

// The same dead opt-in through a top-level constant and an early return.
const SKIP = process.env.GBRAIN_FIXTURE_SKIP_SUBPROCESS === '1';

describe('subprocess', () => {
  test('spawns', () => {
    if (SKIP) return;
  });
});
