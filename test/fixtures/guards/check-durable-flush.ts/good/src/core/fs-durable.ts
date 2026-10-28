import { closeSync, fsyncSync, openSync } from 'node:fs';

export function flushDirectory(path: string): void {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
