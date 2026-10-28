/**
 * On Windows, PGLite -> Postgres keeps the legacy copier for history-free
 * brains and refuses brains with write history with
 * graduation_unsupported_platform, before the legacy copier's own refusals.
 * Other platforms and other directions are untouched.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { assertWindowsGraduationPlatform } from '../src/commands/migrate-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' });
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

describe('Windows engine migration routing', () => {
  test('a history-free PGLite brain passes on win32 (legacy copier proceeds)', async () => {
    await assertWindowsGraduationPlatform(engine as unknown as BrainEngine, { targetEngine: 'postgres' }, 'win32');
  });

  test('a brain with write history is refused with graduation_unsupported_platform on win32 only', async () => {
    const withHistory = {
      kind: 'pglite',
      executeRaw: async (sql: string) => (sql.includes('information_schema') ? [{ name: 'persistence_requests' }] : [{ present: true }]),
    } as unknown as BrainEngine;
    let code: string | undefined;
    try { await assertWindowsGraduationPlatform(withHistory, { targetEngine: 'postgres' }, 'win32'); } catch (e) { code = (e as { code?: string }).code; }
    expect(code).toBe('graduation_unsupported_platform');
    await assertWindowsGraduationPlatform(withHistory, { targetEngine: 'postgres' }, 'linux');
    await assertWindowsGraduationPlatform(withHistory, { targetEngine: 'pglite' }, 'win32');
  });
});
