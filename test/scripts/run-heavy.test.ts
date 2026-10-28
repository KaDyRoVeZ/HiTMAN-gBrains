import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..', '..');

function fixtureTree(scripts: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-run-heavy-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'tests', 'heavy'), { recursive: true });
  copyFileSync(join(REPO, 'scripts', 'run-heavy.sh'), join(root, 'scripts', 'run-heavy.sh'));
  writeFileSync(join(root, 'tests', 'heavy', '_db_floor.sh'), '');
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(root, 'tests', 'heavy', name), `#!/usr/bin/env bash\n${body}\n`);
  }
  return root;
}

describe('scripts/run-heavy.sh runs every heavy script', () => {
  test('a failing script does not hide later scripts; the summary names each failure with its rerun command', () => {
    const root = fixtureTree({
      'a_fails.sh': 'echo a-ran; exit 3',
      'b_passes.sh': 'echo b-ran',
      'c_fails.sh': 'echo c-ran; exit 5',
    });
    try {
      const result = spawnSync('bash', [join(root, 'scripts', 'run-heavy.sh')], { encoding: 'utf8', timeout: 30_000 });
      expect(result.status).toBe(3);
      expect(result.stdout).toContain('a-ran');
      expect(result.stdout).toContain('b-ran');
      expect(result.stdout).toContain('c-ran');
      expect(result.stderr).toContain('2 of 3 script(s) failed');
      expect(result.stderr).toContain('tests/heavy/a_fails.sh (exit 3); rerun: bash scripts/run-heavy.sh a_fails.sh');
      expect(result.stderr).toContain('tests/heavy/c_fails.sh (exit 5); rerun: bash scripts/run-heavy.sh c_fails.sh');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('all scripts passing exits 0', () => {
    const root = fixtureTree({ 'a.sh': 'true', 'b.sh': 'true' });
    try {
      const result = spawnSync('bash', [join(root, 'scripts', 'run-heavy.sh')], { encoding: 'utf8', timeout: 30_000 });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('all 2 script(s) passed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
