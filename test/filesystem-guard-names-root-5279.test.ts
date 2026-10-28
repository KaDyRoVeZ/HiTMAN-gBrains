/**
 * #5279: the managed-worktree refusal named no root, so an operator with a
 * stray ownership file could not tell which directory or source it came from.
 * The writer_coordinator_required error now names the matched root, its source
 * when the registry recorded one, and the evidence (marker file or record).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertManagedFilesystemWrite } from '../src/core/persistence/filesystem-guard.ts';
import { canonicalFilesystemPath, recordManagedRoots } from '../src/core/persistence/root-registry.ts';
import { withEnv } from './helpers/with-env.ts';

const dir = mkdtempSync(join(tmpdir(), 'gbrain-guard-5279-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function refusal(path: string): { code?: string; message: string; detail?: string } {
  try { assertManagedFilesystemWrite(path); } catch (error) { return error as { code?: string; message: string; detail?: string }; }
  throw new Error('expected a writer_coordinator_required refusal');
}

describe('managed worktree refusal names its root (#5279)', () => {
  test('a stray ownership marker: the error names the marked root and the marker file', () =>
    withEnv({ GBRAIN_HOME: join(dir, 'home-a') }, () => {
      const root = join(dir, 'stray');
      mkdirSync(join(root, 'notes'), { recursive: true });
      writeFileSync(join(root, '.gbrain-owner.json'), '{}');
      const error = refusal(join(root, 'notes', 'a.md'));
      const canonical = canonicalFilesystemPath(root);
      expect(error.code).toBe('writer_coordinator_required');
      expect(error.message).toContain(canonical);
      expect(error.detail).toBe(`root=${canonical} source=unknown evidence=${join(canonical, '.gbrain-owner.json')}`);
    }));

  test('a registered root: the error names the source the registry recorded', () =>
    withEnv({ GBRAIN_HOME: join(dir, 'home-b') }, () => {
      const root = join(dir, 'registered');
      mkdirSync(root, { recursive: true });
      recordManagedRoots('00000000-0000-4000-8000-000000000001', [{ local_path: root, source_id: 'source-example' }]);
      const error = refusal(join(root, 'b.md'));
      const canonical = canonicalFilesystemPath(root);
      expect(error.message).toContain(`${canonical} (source source-example)`);
      expect(error.detail).toContain(`root=${canonical} source=source-example`);
    }));
});
