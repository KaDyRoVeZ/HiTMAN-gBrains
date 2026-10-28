import { chmodSync, closeSync, fsyncSync, openSync } from 'node:fs';

export function publish(stagingPath: string, mode: number): void {
  chmodSync(stagingPath, mode);
  const fd = openSync(stagingPath, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
