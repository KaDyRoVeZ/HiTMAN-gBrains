/**
 * Windows flush semantics on a POSIX test host (#5595, #5475).
 *
 * Windows `FlushFileBuffers` needs write access, so fsyncSync on a descriptor
 * opened read-only fails with EPERM there. `simulateReadOnlyFsyncEperm` makes
 * fsyncSync of a read-only regular-file descriptor fail the same way, so a
 * regression that flushes through an `'r'` handle fails on Linux and macOS
 * too. `withPlatform` reports another `process.platform` around pure
 * filesystem code (never around native locks or engines). Native behaviour is
 * proven by the same suites on the windows-latest security-regressions row.
 */
import { spyOn } from 'bun:test';
import * as fs from 'node:fs';

export interface FlushSimulation { readOnlyFsyncs: number; restore(): void }

export function simulateReadOnlyFsyncEperm(options: { directories?: boolean } = {}): FlushSimulation {
  const readOnly = new Set<number>();
  const open = fs.openSync, close = fs.closeSync, fsync = fs.fsyncSync, fstat = fs.fstatSync;
  const simulation: FlushSimulation = { readOnlyFsyncs: 0, restore: () => {} };
  const opened = spyOn(fs, 'openSync').mockImplementation(((path: fs.PathLike, flags: fs.OpenMode = 'r', mode?: fs.Mode | null) => {
    const fd = open(path, flags, mode);
    const writable = typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0 : /[wa+]/.test(flags);
    if (writable) readOnly.delete(fd); else readOnly.add(fd);
    return fd;
  }) as typeof fs.openSync);
  const closed = spyOn(fs, 'closeSync').mockImplementation(fd => { readOnly.delete(fd); close(fd); });
  const synced = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (readOnly.has(fd) && (options.directories || !fstat(fd).isDirectory())) {
      simulation.readOnlyFsyncs++;
      throw Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM', syscall: 'fsync' });
    }
    fsync(fd);
  });
  simulation.restore = () => { opened.mockRestore(); closed.mockRestore(); synced.mockRestore(); };
  return simulation;
}

export function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  try { return run(); } finally { Object.defineProperty(process, 'platform', descriptor); }
}
