/**
 * F0 `gbrain sources refresh`, spec test 1.8.2 (O-ENG-9, "restart converges").
 *
 * Protects: a process killed after `git merge --ff-only` and before the merged
 * bookkeeping commits leaves the worktree fenced; the next owner start moves
 * the refresh to `syncing` (only because HEAD is the verified target and the
 * old HEAD is its ancestor), `--resume` completes it with every member at the
 * target commit, and the write accepted before the fence is committed.
 * Regression it catches: recovery adopting an unverified HEAD, recovery not
 * wired into owner startup, or accepted writes lost across the crash.
 * Seams: a real child process exits inside the refresh's `merged` boundary.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';
import { git, page, setupRefreshFixture } from './helpers/worktree-refresh-fixture.ts';

const backends = testBackends();
const dir = mkdtempSync(join(tmpdir(), 'gbrain-refresh-restart-'));
const cases: Array<{ engine: BrainEngine; database: GBrainConfig; close: () => Promise<void> }> = [];

beforeAll(async () => {
  if (backends.includes('pglite')) {
    const database = { engine: 'pglite', database_path: join(dir, 'brain.pglite') } as GBrainConfig;
    const engine = new PGLiteEngine();
    await engine.connect(database); await engine.initSchema();
    cases.push({ engine, database, close: () => engine.disconnect() });
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    cases.push({ engine: pg.engine, database: { engine: 'postgres', database_url: pg.databaseUrl } as GBrainConfig, close: pg.close });
  }
}, 120_000);
afterAll(async () => {
  for (const item of cases) { await disposePersistenceConsumer(item.engine); await item.close(); }
  rmSync(dir, { recursive: true, force: true });
});

function child(env: Record<string, string>, payload: Record<string, unknown>): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [join(import.meta.dir, 'helpers/worktree-refresh-child.ts')],
    { env: { ...process.env, ...env, GBRAIN_TEST_REFRESH_CHILD: JSON.stringify(payload) }, encoding: 'utf8', timeout: 90_000 });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

test('2. O-ENG-9: a crash after git merge and before bookkeeping converges after restart: syncing, then completed', async () => {
  for (const [index, item] of cases.entries()) {
    const caseDir = mkdtempSync(join(dir, `case-${index}-`));
    const home = join(caseDir, 'home');
    let f!: Awaited<ReturnType<typeof setupRefreshFixture>>;
    await withEnv({ GBRAIN_HOME: home }, async () => {
      f = await setupRefreshFixture(item.engine, caseDir);
      await disposePersistenceConsumer(item.engine);
    });
    const target = f.push('alpha/two.md', page('Alpha two', 'An observation that survived a crash.'));
    const old = f.head();
    if (item.engine.kind === 'pglite') await item.engine.disconnect();
    const payload = { database: item.database, sourceId: f.alpha, worktreeId: f.worktreeId };

    const crashed = child({ GBRAIN_HOME: home }, { ...payload, mode: 'crash' });
    expect(crashed.stdout, crashed.stderr).toContain('REFRESH_CRASH_AFTER_MERGE');
    expect(crashed.status).toBe(137);
    expect(git(f.root, 'rev-parse', 'HEAD')).toBe(target);
    expect(target).not.toBe(old);

    const restarted = child({ GBRAIN_HOME: home }, { ...payload, mode: 'restart' });
    const line = restarted.stdout.split('\n').find(row => row.startsWith('REFRESH_RESULT '));
    expect(line, `${restarted.stdout}\n${restarted.stderr}`).toBeDefined();
    const report = JSON.parse(line!.slice('REFRESH_RESULT '.length)) as { seen: string[]; result: { status: string; synced: Array<{ last_commit: string }> };
      requests: Array<{ state: string; slug: string }> };
    expect(report.seen[0]).toBe('fenced');
    expect(report.seen).toContain('syncing');
    expect(report.seen[report.seen.length - 1]).toBe('completed');
    expect(report.result.status).toBe('completed');
    expect(report.result.synced.map(member => member.last_commit)).toEqual([target, target]);
    const preFence = report.requests.filter(row => row.slug === 'notes/pre-fence');
    expect(preFence).toHaveLength(1);
    expect(report.requests.every(row => row.state === 'committed')).toBe(true);
  }
}, 300_000);
