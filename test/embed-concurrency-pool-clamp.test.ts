/**
 * #5183: `embed --stale` wedged (no progress, no error, 0% CPU) when
 * GBRAIN_EMBED_CONCURRENCY (default 20) exceeded the Postgres client pool:
 * every worker holds a connection, so extra workers waited on the pool
 * forever. Embed concurrency is now clamped to the pool on Postgres. Both
 * embed loops' worker counts are exercised in embed.serial.test.ts.
 */

import { describe, test, expect, spyOn } from 'bun:test';

import { _resetEmbedConcurrencyClampWarningForTest, resolveEmbedConcurrency } from '../src/commands/embed.ts';

describe('#5183 embed concurrency never exceeds the Postgres pool', () => {
  test('an explicit setting above the pool is clamped, with one warning per process', () => {
    _resetEmbedConcurrencyClampWarningForTest();
    const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(resolveEmbedConcurrency('postgres', undefined, { GBRAIN_EMBED_CONCURRENCY: '20' }, 12)).toBe(12);
      expect(resolveEmbedConcurrency('postgres', undefined, { GBRAIN_EMBED_CONCURRENCY: '20' }, 12)).toBe(12);
      const lines = err.mock.calls.map(c => String(c[0])).filter(l => l.includes('[embed]'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('GBRAIN_EMBED_CONCURRENCY=20 is above the connection pool (12); using 12 workers');
      expect(lines[0]).toContain('GBRAIN_POOL_SIZE');
    } finally {
      err.mockRestore();
    }
  });

  test('the default 20 is clamped to the pool silently (the pool-2 guidance case)', () => {
    _resetEmbedConcurrencyClampWarningForTest();
    const err = spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(resolveEmbedConcurrency('postgres', undefined, {}, 2)).toBe(2);
      expect(err.mock.calls.filter(c => String(c[0]).includes('[embed]'))).toHaveLength(0);
    } finally {
      err.mockRestore();
    }
  });

  test('unchanged when the pool is large enough, on PGLite, and for a lower paced cap', () => {
    expect(resolveEmbedConcurrency('postgres', undefined, { GBRAIN_EMBED_CONCURRENCY: '8' }, 12)).toBe(8);
    expect(resolveEmbedConcurrency('pglite', undefined, {}, 2)).toBe(20);
    expect(resolveEmbedConcurrency('postgres', 4, {}, 12)).toBe(4);
    expect(resolveEmbedConcurrency('postgres', undefined, { GBRAIN_EMBED_CONCURRENCY: 'junk' }, 50)).toBe(20);
  });
});
