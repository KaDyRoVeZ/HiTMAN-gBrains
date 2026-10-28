import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { checkSyncFailures } from '../src/commands/doctor/checks/sync-failures.ts';
import { recordFailures } from '../src/core/sync-failure-ledger.ts';
import { withEnv } from './helpers/with-env.ts';

// #7144: test-fixture rows (notes/bad.md, SLUG_MISMATCH) written into an operator's real ledger kept
// sync_failures at fail level. An unmanaged row no sync can ever retry or clear (its source is not
// registered, or its file was deleted from the source's own history after it failed) is set aside and counted,
// not graded. A row whose commit the checkout does not know (a replaced source, #6543) keeps its grade.
const home = mkdtempSync(join(tmpdir(), 'gbrain-7144-'));
const checkout = join(home, 'checkout');
const env = { GBRAIN_SYNC_FAILURES_DIR: home };

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  rmSync(home, { recursive: true, force: true });
});

beforeEach(async () => {
  await engine.executeRaw('TRUNCATE sources CASCADE');
  rmSync(join(home, 'sync-failures.jsonl'), { force: true });
  rmSync(checkout, { recursive: true, force: true });
  mkdirSync(join(checkout, 'notes'), { recursive: true });
  writeFileSync(join(checkout, 'notes', 'alice-example.md'), '---\ntitle: x\n---\n');
  writeFileSync(join(checkout, 'notes', 'bad.md'), '---\ntitle: Bad\nslug: wrong-slug\n---\n');
  git('init', '-q');
  git('add', '-A');
  git('commit', '-qm', 'initial');
  failedAt = git('rev-parse', 'HEAD').trim();
  git('rm', '-q', 'notes/bad.md');
  git('commit', '-qm', 'delete the bad file');
});

let failedAt = '';
function git(...args: string[]): string {
  return execFileSync('git', ['-C', checkout, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
}

const slugMismatch = (path: string) => ({ path, error: 'SLUG_MISMATCH: frontmatter slug "wrong-slug" does not match the path' });

describe('sync_failures sets aside ledger rows no sync can clear (#7144)', () => {
  test('rows on an unregistered source and rows whose file is gone are ignored and counted; a live row still grades', async () => withEnv(env, async () => {
    await engine.executeRaw('INSERT INTO sources(id, name, local_path) VALUES($1, $1, $2)', ['src-live', checkout]);
    recordFailures('srcE', [slugMismatch('notes/bad.md')], failedAt);
    recordFailures('src-live', [slugMismatch('notes/bad.md')], failedAt);
    recordFailures('src-live', [slugMismatch('notes/alice-example.md')], failedAt);

    const check = await checkSyncFailures(engine, { remote: false });
    expect(check!.status).toBe('warn');
    expect(check!.message).toContain('1 unresolved sync failure(s)');
    expect(check!.message).toContain('2 local-ledger row(s) ignored because no sync can retry or clear them (1 on a source that is not registered, 1 whose file was deleted from its source after it failed)');
    expect(check!.message).toContain('notes/alice-example.md');
    expect(check!.message).not.toContain('notes/bad.md');
  }));

  test('a ledger holding only unreachable rows grades ok and says what it ignored', async () => withEnv(env, async () => {
    await engine.executeRaw('INSERT INTO sources(id, name, local_path) VALUES($1, $1, $2)', ['src-live', checkout]);
    recordFailures('srcE', [slugMismatch('notes/bad.md')], failedAt);
    recordFailures('src-live', [slugMismatch('notes/bad.md')], failedAt);

    const check = await checkSyncFailures(engine, { remote: false });
    expect(check?.status).toBe('ok');
    expect(check!.message).toContain('2 local-ledger row(s) ignored');
  }));

  test('a missing file whose commit the checkout does not know (a replaced source) keeps its grade', async () => withEnv(env, async () => {
    await engine.executeRaw('INSERT INTO sources(id, name, local_path) VALUES($1, $1, $2)', ['src-live', checkout]);
    recordFailures('src-live', [slugMismatch('notes/old.md')], '0123456789abcdef0123456789abcdef01234567');

    const check = await checkSyncFailures(engine, { remote: false });
    expect(check!.message).toContain('1 unresolved sync failure(s)');
    expect(check!.message).toContain('notes/old.md');
    expect(check!.message).not.toContain('ignored because no sync');
  }));

  test('a source whose checkout is missing, or that has no checkout, keeps its rows', async () => withEnv(env, async () => {
    await engine.executeRaw('INSERT INTO sources(id, name, local_path) VALUES($1, $1, $2), ($3, $3, NULL)', ['src-unmounted', join(home, 'not-mounted'), 'src-db-only']);
    recordFailures('src-unmounted', [slugMismatch('notes/bad.md')], failedAt);
    recordFailures('src-db-only', [slugMismatch('notes/bad.md')], failedAt);

    const check = await checkSyncFailures(engine, { remote: false });
    expect(check!.message).toContain('2 unresolved sync failure(s)');
    expect(check!.message).not.toContain('ignored because no sync');
  }));

  test('remote callers get counts only', async () => withEnv(env, async () => {
    recordFailures('srcE', [slugMismatch('notes/bad.md')], failedAt);
    const check = await checkSyncFailures(engine, { remote: true });
    expect(check?.status).toBe('ok');
    expect(check!.message).toContain('1 local-ledger row(s) ignored');
    expect(check!.message).not.toContain('srcE');
    expect(check!.message).not.toContain('notes/bad.md');
  }));
});
