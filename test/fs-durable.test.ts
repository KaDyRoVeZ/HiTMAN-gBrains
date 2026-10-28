/**
 * src/core/fs-durable.ts: the shared flush helpers behind every canonical
 * writer (#5595, #5475). Native cases run on every OS row of the
 * security-regressions job, windows-latest included; the simulated win32
 * cases make the platform branches discriminate on Linux and macOS.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flushDirectory, flushFile, sameFileMode } from '../src/core/fs-durable.ts';
import { simulateReadOnlyFsyncEperm, withPlatform } from './helpers/win32-flush-semantics.ts';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(join(tmpdir(), 'gbrain-fs-durable-')); });
afterEach(() => {
  try { for (const name of fs.readdirSync(dir)) fs.chmodSync(join(dir, name), 0o644); } catch { /* best-effort before removal */ }
  fs.rmSync(dir, { recursive: true, force: true });
});
const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });

describe('native flushes on this platform', () => {
  test('a directory and a regular file flush without error', () => {
    const file = join(dir, 'page.md');
    fs.writeFileSync(file, 'bytes');
    expect(() => flushDirectory(dir)).not.toThrow();
    expect(() => flushFile(file)).not.toThrow();
    expect(fs.readFileSync(file, 'utf8')).toBe('bytes');
  });

  test('a read-only file stays flushable and keeps its mode', () => {
    const file = join(dir, 'frozen.md');
    fs.writeFileSync(file, 'frozen');
    fs.chmodSync(file, 0o444);
    expect(() => flushFile(file)).not.toThrow();
    expect(sameFileMode(fs.statSync(file).mode, 0o444)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('frozen');
  });

  test('a file passed as a directory fails with ENOTDIR instead of flushing the file', () => {
    const file = join(dir, 'not-a-directory');
    fs.writeFileSync(file, 'x');
    expect(() => flushDirectory(file)).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
  });

  test('a missing directory fails strictly and is swallowed best-effort', () => {
    const missing = join(dir, 'missing');
    expect(() => flushDirectory(missing)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    expect(() => flushDirectory(missing, { bestEffort: true })).not.toThrow();
  });
});

describe('Windows flush contract (simulated on POSIX hosts)', () => {
  test('flushFile flushes through a writable handle on win32, so a read-only-handle EPERM never fires', () => {
    const file = join(dir, 'page.md');
    fs.writeFileSync(file, 'bytes');
    const simulation = simulateReadOnlyFsyncEperm();
    try {
      expect(() => withPlatform('win32', () => flushFile(file))).not.toThrow();
      expect(simulation.readOnlyFsyncs).toBe(0);
    } finally { simulation.restore(); }
  });

  test('a raw read-only-handle fsync is what fails under the simulation', () => {
    const file = join(dir, 'page.md');
    fs.writeFileSync(file, 'bytes');
    const simulation = simulateReadOnlyFsyncEperm();
    try {
      const fd = fs.openSync(file, 'r');
      try { expect(() => fs.fsyncSync(fd)).toThrow(expect.objectContaining({ code: 'EPERM' })); } finally { fs.closeSync(fd); }
    } finally { simulation.restore(); }
  });

  test('flushFile leaves a read-only file to the OS on win32 instead of failing the writer', () => {
    const file = join(dir, 'frozen.md');
    fs.writeFileSync(file, 'frozen');
    fs.chmodSync(file, 0o444);
    const opened = spyOn(fs, 'openSync').mockImplementation(() => { throw errno('EPERM'); });
    try { expect(() => withPlatform('win32', () => flushFile(file))).not.toThrow(); } finally { opened.mockRestore(); }
  });

  test('flushFile still fails on win32 when a writable file refuses a writable handle', () => {
    const file = join(dir, 'locked.md');
    fs.writeFileSync(file, 'locked');
    const opened = spyOn(fs, 'openSync').mockImplementation(() => { throw errno('EPERM'); });
    try { expect(() => withPlatform('win32', () => flushFile(file))).toThrow(expect.objectContaining({ code: 'EPERM' })); } finally { opened.mockRestore(); }
  });

  for (const code of ['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP']) {
    test(`strict directory flush tolerates the win32 no-directory-flush code ${code}`, () => {
      const opened = spyOn(fs, 'openSync').mockImplementation(() => { throw errno(code); });
      try {
        expect(() => withPlatform('win32', () => flushDirectory(dir))).not.toThrow();
        expect(() => withPlatform('linux', () => flushDirectory(dir))).toThrow(expect.objectContaining({ code }));
      } finally { opened.mockRestore(); }
    });
  }

  test.skipIf(process.platform === 'win32')('a directory handle that cannot be fsynced is tolerated on win32 only', () => {
    const simulation = simulateReadOnlyFsyncEperm({ directories: true });
    try {
      expect(() => withPlatform('win32', () => flushDirectory(dir))).not.toThrow();
      expect(() => withPlatform('linux', () => flushDirectory(dir))).toThrow(expect.objectContaining({ code: 'EPERM' }));
    } finally { simulation.restore(); }
  });

  test('strict directory flush surfaces real I/O failures on every platform; best-effort swallows them', () => {
    const opened = spyOn(fs, 'openSync').mockImplementation(() => { throw errno('EIO'); });
    try {
      expect(() => withPlatform('linux', () => flushDirectory(dir))).toThrow(expect.objectContaining({ code: 'EIO' }));
      expect(() => withPlatform('win32', () => flushDirectory(dir))).toThrow(expect.objectContaining({ code: 'EIO' }));
      expect(() => flushDirectory(dir, { bestEffort: true })).not.toThrow();
    } finally { opened.mockRestore(); }
  });
});

describe('sameFileMode', () => {
  test('POSIX compares every permission bit', () => {
    withPlatform('linux', () => {
      expect(sameFileMode(0o100644, 0o644)).toBe(true);
      expect(sameFileMode(0o100666, 0o644)).toBe(false);
      expect(sameFileMode(0o100600, 0o644)).toBe(false);
    });
  });

  test('win32 compares only the owner write bit it can represent', () => {
    withPlatform('win32', () => {
      expect(sameFileMode(0o666, 0o644)).toBe(true);
      expect(sameFileMode(0o666, 0o600)).toBe(true);
      expect(sameFileMode(0o444, 0o444)).toBe(true);
      expect(sameFileMode(0o444, 0o644)).toBe(false);
      expect(sameFileMode(0o666, 0o444)).toBe(false);
    });
  });
});
