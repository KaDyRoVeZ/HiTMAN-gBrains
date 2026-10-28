/**
 * Protects: the canonical-root overlap scan in `sources add` treats a
 * subdirectory that disappears mid-scan (Git's background auto-gc packing
 * loose objects under .git/objects) as holding no reservation, instead of
 * failing the add with ENOENT.
 * Fails when: assertNoPhysicalRootOverlap rethrows ENOENT for a vanished
 * subdirectory, or swallows ENOENT for the root itself.
 * Seam: mock.module('node:fs') makes readdirSync throw ENOENT for one path.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const realFs = { ...fs };
const root = realFs.mkdtempSync(join(tmpdir(), 'gbrain-overlap-'));
const vanished = join(root, '.git', 'objects', '9c');
realFs.mkdirSync(vanished, { recursive: true });
let failPath = vanished;
const enoent = (path: string) => Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), { code: 'ENOENT' });

mock.module('node:fs', () => ({
  ...realFs,
  readdirSync: (path: fs.PathLike, ...rest: unknown[]) => {
    if (String(path) === failPath) throw enoent(String(path));
    return (realFs.readdirSync as (...args: unknown[]) => unknown)(path, ...rest);
  },
}));
const { assertNoPhysicalRootOverlap } = await import('../src/core/persistence/physical-root-record.ts');

afterAll(() => realFs.rmSync(root, { recursive: true, force: true }));

describe('assertNoPhysicalRootOverlap', () => {
  test('a subdirectory that vanishes during the scan holds no reservation', () => {
    failPath = vanished;
    expect(() => assertNoPhysicalRootOverlap(root)).not.toThrow();
  });

  test('a root that cannot be read still fails', () => {
    failPath = root;
    expect(() => assertNoPhysicalRootOverlap(root)).toThrow('ENOENT');
  });
});
