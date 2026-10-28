import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');

describe('scripts/postinstall.ts exits 0 on every path', () => {
  test('runs from a directory holding only package.json and the script (Docker dependency layer)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-postinstall-standalone-'));
    try {
      mkdirSync(join(dir, 'scripts'));
      copyFileSync(join(REPO, 'package.json'), join(dir, 'package.json'));
      copyFileSync(join(REPO, 'scripts', 'postinstall.ts'), join(dir, 'scripts', 'postinstall.ts'));
      const result = spawnSync(process.execPath, ['--no-env-file', join(dir, 'scripts', 'postinstall.ts')], {
        cwd: dir,
        env: { HOME: dir, GBRAIN_HOME: dir, PATH: '/usr/bin:/bin' },
        encoding: 'utf8',
        timeout: 30_000,
      });
      expect(result.status, result.stderr + result.stdout).toBe(0);
      expect(result.stderr).toContain('postinstall skipped');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
