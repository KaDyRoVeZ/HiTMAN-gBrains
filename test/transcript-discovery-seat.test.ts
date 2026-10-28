/**
 * #4618: dream discovery reads a session's `.seat.json` sidecar for every
 * corpus file of that session (session-end file, checkpoint segment), never
 * ingests the sidecar as a transcript, and ignores a sidecar whose seat is not
 * a valid label (it would otherwise reach page frontmatter verbatim).
 *
 * Authoring gate: protects the discovery half of the seat contract; the
 * end-to-end stamp test only covers whole-session `.txt` files. No seam.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { discoverTranscripts } from '../src/core/cycle/transcript-discovery.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gb-seat-disc-')); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const body = (topic: string) => `[user]\nLet us talk about ${topic}.\n\n${'[assistant]\nA long and useful answer.\n\n'.repeat(10)}`;
const sidecar = (sid: string, seat: string) =>
  writeFileSync(join(dir, `${sid}.seat.json`), JSON.stringify({ version: 1, seat, seat_source: 'env', hook_lane: 'workspace', harness: 'claude-code', first_seen: '2026-09-20T00:00:00.000Z' }));

test('every corpus file of a session carries its seat; the sidecar is never a transcript; an invalid seat is ignored', () => {
  writeFileSync(join(dir, 'sess-a.txt'), body('the storage plan'));
  writeFileSync(join(dir, 'sess-a.seg-0123456789abcdef01234567.txt'), body('an earlier window'));
  sidecar('sess-a', 'alice-desk');
  writeFileSync(join(dir, 'sess-b.txt'), body('the budget'));
  sidecar('sess-b', '../Not A Seat');
  writeFileSync(join(dir, 'sess-c.txt'), body('the garden'));

  const found = discoverTranscripts({ corpusDir: dir, minChars: 50 });
  expect(found.map((t) => basename(t.filePath))).toEqual([
    'sess-a.seg-0123456789abcdef01234567.txt', 'sess-a.txt', 'sess-b.txt', 'sess-c.txt',
  ]);
  expect(found.map((t) => t.seat)).toEqual(['alice-desk', 'alice-desk', undefined, undefined]);
});
