/**
 * Durable flush primitives for every canonical and private-state writer.
 *
 * The POSIX idiom `fsync(open(path, 'r'))` does not port: Windows
 * `FlushFileBuffers` needs a handle with write access (a read-only handle
 * fails with EPERM, #5595), and Windows cannot open a directory through the
 * file-descriptor API at all (#5475). A writer that still holds the
 * descriptor it wrote through sets the final mode with `fchmodSync(fd)` and
 * fsyncs that descriptor before closing it (atomic-write.ts); these helpers
 * cover the paths that have no descriptor. scripts/check-durable-flush.ts
 * fails on an fsyncSync of a read-only descriptor anywhere else in src/.
 */
import { closeSync, fstatSync, fsyncSync, openSync, statSync } from 'node:fs';

/** Errors Windows returns where it has no directory flush; the rename is already durable there. */
const WIN32_NO_DIRECTORY_FLUSH = new Set(['EISDIR', 'EPERM', 'EINVAL', 'ENOTSUP']);

const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException)?.code ?? '';

/**
 * fsync a file nobody holds open. Windows needs a writable handle (`'r+'`);
 * elsewhere `'r'` keeps a read-only (0444) file flushable. A read-only file on
 * Windows cannot be opened writable at all, so its flush is left to the
 * operating system rather than failing the caller.
 */
export function flushFile(path: string): void {
  const win32 = process.platform === 'win32';
  let fd: number;
  try {
    fd = openSync(path, win32 ? 'r+' : 'r');
  } catch (error) {
    if (win32 && ['EPERM', 'EACCES'].includes(errorCode(error)) && (statSync(path).mode & 0o200) === 0) return;
    throw error;
  }
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export interface DirectoryFlushOptions {
  /** Swallow every error: for callers whose directory flush is advisory, not part of their durability contract. */
  bestEffort?: boolean;
}

/**
 * fsync a directory so a create, rename or unlink inside it survives power
 * loss. Strict by default: every error propagates except the Windows codes
 * that mean the platform has no directory flush. A path that is not a
 * directory fails with ENOTDIR instead of silently flushing a file.
 */
export function flushDirectory(path: string, options: DirectoryFlushOptions = {}): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    if (!fstatSync(fd).isDirectory()) {
      throw Object.assign(new Error(`ENOTDIR: not a directory, fsync '${path}'`), { code: 'ENOTDIR', syscall: 'fsync', path });
    }
    fsyncSync(fd);
  } catch (error) {
    if (options.bestEffort) return;
    if (process.platform === 'win32' && WIN32_NO_DIRECTORY_FLUSH.has(errorCode(error))) return;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Whether a file's observed permission bits match the mode it was published
 * with. Windows keeps only a read-only attribute, which stat reports as 0444
 * or 0666, so only the owner write bit is comparable there.
 */
export function sameFileMode(actual: number, expected: number): boolean {
  if (process.platform === 'win32') return (actual & 0o200) === (expected & 0o200);
  return (actual & 0o7777) === (expected & 0o7777);
}
