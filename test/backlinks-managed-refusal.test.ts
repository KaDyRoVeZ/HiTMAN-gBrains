/**
 * #5341: `check-backlinks fix` writes markdown directly, which a managed
 * canonical worktree refuses page by page ("Fixed 0 ... Skipped 32 page(s)")
 * while --dry-run claimed every fix would apply. The fixer now refuses once,
 * before the scan, for real runs and dry runs alike; `check` still works.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBacklinksCore } from '../src/commands/backlinks.ts';

const roots: string[] = [];
function brain(managed: boolean): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-backlinks-'));
  roots.push(root);
  mkdirSync(join(root, 'people'));
  mkdirSync(join(root, 'meetings'));
  writeFileSync(join(root, 'people', 'alice-example.md'), '---\ntitle: Alice Example\n---\n# Alice Example\n');
  writeFileSync(join(root, 'meetings', 'planning.md'), '---\ntitle: Planning\n---\nMet [Alice Example](../people/alice-example.md).\n');
  if (managed) writeFileSync(join(root, '.gbrain-managed'), JSON.stringify({ managed: true, version: 1 }));
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('#5341 check-backlinks on a managed canonical worktree', () => {
  test('fix and fix --dry-run refuse once with a mode-level error; the page is untouched', async () => {
    const root = brain(true);
    for (const dryRun of [false, true]) {
      await expect(runBacklinksCore({ action: 'fix', dir: root, dryRun })).rejects.toThrow('not supported on a managed canonical worktree');
    }
    expect(readFileSync(join(root, 'people', 'alice-example.md'), 'utf8')).not.toContain('planning');
  });

  test('check still reports the gaps on a managed worktree', async () => {
    const result = await runBacklinksCore({ action: 'check', dir: brain(true) });
    expect(result.gaps_found).toBe(1);
  });

  test('an unmanaged brain still fixes', async () => {
    const root = brain(false);
    const result = await runBacklinksCore({ action: 'fix', dir: root });
    expect(result.fixed).toBe(1);
    expect(readFileSync(join(root, 'people', 'alice-example.md'), 'utf8')).toContain('planning');
  });
});
