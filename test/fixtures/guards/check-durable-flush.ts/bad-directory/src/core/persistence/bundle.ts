import { closeSync, constants, fsyncSync, openSync } from 'node:fs';

function flushBundleDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function publish(directory: string): void { flushBundleDirectory(directory); }
