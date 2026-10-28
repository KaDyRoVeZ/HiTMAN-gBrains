/**
 * #5638: a takes fence write lands in git on a durability-hardened repo, the
 * same #2426 contract put_page write-through follows. Unhardened repos keep
 * the write-only behavior.
 *
 * .serial: real git subprocesses against tmp repos.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { addTakeToPage, updateTakeOnPage } from '../src/core/takes-write.ts';

let engine: PGLiteEngine;
const dirs: string[] = [];
const slug = 'notes/takes-commit-example';

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function seedRepo(hardened: boolean): Promise<string> {
  const repo = mkdtempSync(join(tmpdir(), 'gbrain-takes-commit-'));
  dirs.push(repo);
  const fixture = await makeGitFixture(repo);
  if (hardened) {
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.git', 'hooks', 'post-commit'), '#!/usr/bin/env bash\n# gbrain brain-durability post-commit hook (v0.42.44+)\nexit 0\n');
    chmodSync(join(repo, '.git', 'hooks', 'post-commit'), 0o755);
  }
  await engine.putPage(slug, { type: 'note', title: 'Takes commit example', compiled_truth: 'About the example.' });
  const snapshot = (await engine.readPageSnapshot(slug))!;
  mkdirSync(join(repo, 'notes'), { recursive: true });
  writeFileSync(join(repo, `${slug}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
  writeFileSync(join(repo, 'unrelated.md'), 'committed\n');
  fixture.commitAll('seed page');
  writeFileSync(join(repo, 'unrelated.md'), 'dirty unrelated edit\n');
  return repo;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
beforeEach(async () => { await resetPgliteState(engine); });
afterAll(async () => {
  await engine.disconnect();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

test('on a hardened repo each fence mutation commits only the page file', async () => {
  const repo = await seedRepo(true);
  const head = git(repo, 'rev-parse', 'HEAD');
  const target = { engine, slug, brainDir: repo };

  const added = await addTakeToPage(target, { claim: 'This take reaches git', kind: 'take', holder: 'world' });
  expect(git(repo, 'rev-list', '--count', `${head}..HEAD`)).toBe('1');
  expect(git(repo, 'log', '-1', '--format=%s')).toBe(`gbrain: write-through ${slug}`);
  expect(git(repo, 'show', '--name-only', '--format=', 'HEAD')).toBe(`${slug}.md`);
  expect(git(repo, 'show', `HEAD:${slug}.md`)).toContain('This take reaches git');

  await updateTakeOnPage(target, added.rowNum, { weight: 0.9 });
  expect(git(repo, 'rev-list', '--count', `${head}..HEAD`)).toBe('2');
  expect(git(repo, 'status', '--porcelain')).toBe('M unrelated.md');
  expect(readFileSync(join(repo, 'unrelated.md'), 'utf8')).toBe('dirty unrelated edit\n');
});

test('on an unhardened repo the fence write stays uncommitted', async () => {
  const repo = await seedRepo(false);
  const head = git(repo, 'rev-parse', 'HEAD');
  const result = await addTakeToPage({ engine, slug, brainDir: repo }, { claim: 'Written but not committed', kind: 'take', holder: 'world' });
  expect(result.mirror.written).toBe(true);
  expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
  expect(git(repo, 'status', '--porcelain').split('\n').map(line => line.trim()).sort()).toEqual(['M notes/takes-commit-example.md', 'M unrelated.md']);
});
