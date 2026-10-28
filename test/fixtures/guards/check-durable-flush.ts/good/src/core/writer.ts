import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { flushDirectory } from './fs-durable.ts';

export function readHeader(path: string): number {
  const fd = openSync(path, 'r');
  try { return fd; } finally { closeSync(fd); }
}

export function writeDurably(path: string, bytes: Buffer): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  const out = openSync(`${path}.copy`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { fsyncSync(out); } finally { closeSync(out); }
  flushDirectory(dirname(path));
}
