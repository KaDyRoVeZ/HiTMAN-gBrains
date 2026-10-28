import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_LONG_JOB_NAMES,
  DEFAULT_SHORT_JOB_RESERVED_SLOTS,
  LONG_JOB_NAMES_KEY,
  SHORT_JOB_RESERVED_SLOTS_KEY,
  claimExclusions,
  describeLanePolicy,
  longJobSlots,
  parseLongJobNames,
  parseReservedSlots,
  resolveLanePolicy,
} from '../src/core/minions/lanes.ts';
import { HANDLER_DEFAULT_TIMEOUT_MS } from '../src/core/minions/handler-timeouts.ts';
import { MinionWorker } from '../src/core/minions/worker.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const LONG = ['long-a', 'long-b'];

describe('longJobSlots', () => {
  test('reserves slots only at concurrency >= 2 and always leaves one long slot', () => {
    expect(longJobSlots(1, 1)).toBe(1);
    expect(longJobSlots(2, 1)).toBe(1);
    expect(longJobSlots(4, 1)).toBe(3);
    expect(longJobSlots(4, 2)).toBe(2);
    expect(longJobSlots(2, 5)).toBe(1);
    expect(longJobSlots(4, 0)).toBe(4);
  });
});

describe('claimExclusions', () => {
  test('excludes long names once in-flight long jobs fill the long slots', () => {
    expect(claimExclusions({ concurrency: 2, shortJobReservedSlots: 1, longJobNames: LONG }, [])).toEqual([]);
    expect(claimExclusions({ concurrency: 2, shortJobReservedSlots: 1, longJobNames: LONG }, ['short'])).toEqual([]);
    expect(claimExclusions({ concurrency: 2, shortJobReservedSlots: 1, longJobNames: LONG }, ['long-b'])).toEqual(LONG);
    expect(claimExclusions({ concurrency: 4, shortJobReservedSlots: 1, longJobNames: LONG }, ['long-a', 'long-b'])).toEqual([]);
    expect(claimExclusions({ concurrency: 4, shortJobReservedSlots: 1, longJobNames: LONG }, ['long-a', 'long-b', 'long-a'])).toEqual(LONG);
  });

  test('reserved 0, concurrency 1 and an empty long set never exclude', () => {
    expect(claimExclusions({ concurrency: 2, shortJobReservedSlots: 0, longJobNames: LONG }, ['long-a'])).toEqual([]);
    expect(claimExclusions({ concurrency: 1, shortJobReservedSlots: 1, longJobNames: LONG }, [])).toEqual([]);
    expect(claimExclusions({ concurrency: 2, shortJobReservedSlots: 1, longJobNames: [] }, ['long-a'])).toEqual([]);
  });
});

describe('config parsing', () => {
  test('long job names accept a comma list or a JSON array', () => {
    expect(parseLongJobNames(' sync , book-mirror ,, ')).toEqual(['sync', 'book-mirror']);
    expect(parseLongJobNames('["sync", "book-mirror", 3, ""]')).toEqual(['sync', 'book-mirror']);
    expect(parseLongJobNames('[not json')).toEqual([]);
    expect(parseLongJobNames(null)).toEqual([]);
    expect(parseLongJobNames('  ')).toEqual([]);
  });

  test('reserved slots must be a non-negative integer', () => {
    expect(parseReservedSlots('0')).toBe(0);
    expect(parseReservedSlots(' 2 ')).toBe(2);
    expect(parseReservedSlots('-1')).toBeNull();
    expect(parseReservedSlots('1.5')).toBeNull();
    expect(parseReservedSlots('one')).toBeNull();
    expect(parseReservedSlots(null)).toBeNull();
  });
});

function fakeEngine(values: Record<string, string | null> | Error): Pick<BrainEngine, 'getConfig'> {
  return {
    getConfig: async (key: string) => {
      if (values instanceof Error) throw values;
      return values[key] ?? null;
    },
  };
}

describe('resolveLanePolicy', () => {
  test('defaults: one reserved slot and the built-in long names', async () => {
    expect(await resolveLanePolicy(fakeEngine({}))).toEqual({
      longJobNames: [...DEFAULT_LONG_JOB_NAMES],
      shortJobReservedSlots: DEFAULT_SHORT_JOB_RESERVED_SLOTS,
    });
    expect(DEFAULT_SHORT_JOB_RESERVED_SLOTS).toBe(1);
  });

  test('configured names add to the defaults and 0 disables the reservation', async () => {
    const policy = await resolveLanePolicy(fakeEngine({
      [SHORT_JOB_RESERVED_SLOTS_KEY]: '0',
      [LONG_JOB_NAMES_KEY]: 'sync,autopilot-cycle',
    }));
    expect(policy.shortJobReservedSlots).toBe(0);
    expect(policy.longJobNames).toEqual([...DEFAULT_LONG_JOB_NAMES, 'sync']);
  });

  test('an invalid reserved value or a failed read falls back to the defaults', async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (msg: string) => { errors.push(msg); };
    try {
      expect((await resolveLanePolicy(fakeEngine({ [SHORT_JOB_RESERVED_SLOTS_KEY]: 'lots' }))).shortJobReservedSlots).toBe(1);
      expect(await resolveLanePolicy(fakeEngine(new Error('db down')))).toEqual({
        longJobNames: [...DEFAULT_LONG_JOB_NAMES],
        shortJobReservedSlots: 1,
      });
    } finally {
      console.error = original;
    }
    expect(errors.some(e => e.includes(SHORT_JOB_RESERVED_SLOTS_KEY))).toBe(true);
    expect(errors.some(e => e.includes('db down'))).toBe(true);
  });
});

describe('defaults', () => {
  test('every built-in long job has a 30-minute-or-longer handler budget, except doctor-refresh with its own overall budget', () => {
    for (const name of DEFAULT_LONG_JOB_NAMES) {
      if (name === 'doctor-refresh') continue;
      expect(HANDLER_DEFAULT_TIMEOUT_MS[name]).toBeGreaterThanOrEqual(30 * 60 * 1000);
    }
    expect(DEFAULT_LONG_JOB_NAMES).toContain('doctor-refresh');
    expect(DEFAULT_LONG_JOB_NAMES).toContain('autopilot-cycle');
    expect(DEFAULT_LONG_JOB_NAMES).toContain('autopilot-global-maintenance');
    expect(DEFAULT_LONG_JOB_NAMES).not.toContain('facts-absorb');
  });

  test('a worker built without lane options uses the default policy', () => {
    const worker = new MinionWorker({ kind: 'pglite' } as unknown as BrainEngine, {});
    const opts = (worker as unknown as { opts: { longJobNames: readonly string[]; shortJobReservedSlots: number } }).opts;
    expect(opts.longJobNames).toEqual(DEFAULT_LONG_JOB_NAMES);
    expect(opts.shortJobReservedSlots).toBe(1);
  });

  test('the started-line fragment names the long-job budget', () => {
    expect(describeLanePolicy(2, 1)).toBe('long-job lane: 1 of 2 slots');
    expect(describeLanePolicy(2, 0)).toBe('long-job lane: off');
    expect(describeLanePolicy(1, 1)).toBe('long-job lane: off');
  });
});
