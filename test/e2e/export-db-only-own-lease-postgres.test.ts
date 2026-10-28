/**
 * #5842: on Postgres, `apply-migrations --export-db-only` holds its own
 * orchestration lease (a `gbrain_cycle_locks` row) while the export's
 * quiescence check refused on ANY lock row, so the export could never run.
 *
 * Protects: the runner's own lease (matched by id and acquisition token) does
 * not count as activity; any other lock row still refuses with
 * writer_not_quiesced. Regression that fails it: a quiescence query that
 * counts every row, or one that ignores the token and so also excludes a
 * foreign holder of the same lock id.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from '#postgres';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { getEngine, setupDB, teardownDB } from './helpers.ts';
import { SHARED_CONTENT_MIGRATION_VERSION } from '../../src/commands/migrations/shared-content.ts';

const databaseUrl = process.env.DATABASE_URL;
const cli = resolve(import.meta.dir, '../../src/cli.ts');

describe.skipIf(!databaseUrl)('#5842 export-db-only quiescence on Postgres', () => {
  let home = '';
  afterEach(async () => {
    if (home) rmSync(home, { recursive: true, force: true });
    await teardownDB();
    // The export binds the default source to a canonical worktree owned by the
    // deleted HOME; setupDB does not clear ownership tables, so leaving them
    // would park every later file's writes on a dead owner.
    const sql = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    try {
      await sql`UPDATE persistence_brain SET enabled = false, activated_at = NULL WHERE singleton = 1`;
      await sql`DELETE FROM gbrain_cycle_locks`;
      for (const table of ['persistence_requests', 'persistence_topology_changes', 'persistence_source_bindings',
        'persistence_worktrees', 'persistence_host_bindings', 'persistence_local_writers', 'shared_skill_state']) {
        await sql.unsafe(`TRUNCATE ${table} CASCADE`);
      }
      await sql`UPDATE sources SET local_path = NULL, last_commit = NULL, last_sync_at = NULL WHERE id = 'default'`;
      await sql`DELETE FROM config WHERE key LIKE 'shared_skills.%'`;
    } finally { await sql.end(); }
  });

  async function run(args: string[]) {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH!, HOME: home, GBRAIN_HOME: home,
      DATABASE_URL: databaseUrl!, GBRAIN_DATABASE_URL: databaseUrl!,
      GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_GITIGNORE: '1',
    };
    const proc = Bun.spawn([process.execPath, cli, ...args], { cwd: home, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, out: stdout + stderr };
  }

  async function prepare() {
    assertSafeE2eDatabaseUrl(databaseUrl!);
    await setupDB();
    home = mkdtempSync(join(tmpdir(), 'gbrain-5842-'));
    const init = await run(['init', '--non-interactive', '--no-embedding', '--url', databaseUrl!]);
    expect({ code: init.code, out: init.code ? init.out : '' }).toEqual({ code: 0, out: '' });
    const sql = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    try {
      await sql`UPDATE sources SET local_path = NULL WHERE id = 'default'`;
      await sql`DELETE FROM config WHERE key = 'sync.repo_path'`;
      await sql`DELETE FROM gbrain_cycle_locks`;
      await sql`TRUNCATE persistence_requests CASCADE`;
    } finally { await sql.end(); }
    await getEngine().putPage('notes/fixture', { type: 'note', title: 'Fixture', compiled_truth: 'Saved before the export.', timeline: '' }, { sourceId: 'default' });
  }

  const exportArgs = (root: string) => ['apply-migrations', '--migration', SHARED_CONTENT_MIGRATION_VERSION, '--export-db-only',
    '--content-root', root, '--export-source', 'default', '--confirm-quiesced', '--acknowledge-no-backup', '--yes'];

  test('the runner\'s own orchestration lease does not block the export', async () => {
    await prepare();
    const root = join(home, 'canonical');
    const result = await run(exportArgs(root));
    expect(result.out).not.toContain('Active maintenance locks or durable writes remain');
    expect(existsSync(join(root, 'notes/fixture.md'))).toBe(true);
    expect(readFileSync(join(root, 'notes/fixture.md'), 'utf8')).toContain('Saved before the export.');
  }, 180_000);

  test('a foreign lock row still refuses with writer_not_quiesced', async () => {
    await prepare();
    const sql = postgres(databaseUrl!, { max: 1, onnotice: () => {} });
    try {
      await sql`INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at, acquisition_token)
        VALUES ('gbrain-cycle', 1, 'other-host', now(), now() + interval '1 hour', now(), gen_random_uuid())`;
    } finally { await sql.end(); }
    const root = join(home, 'canonical');
    const result = await run(exportArgs(root));
    expect(result.out).toContain('Active maintenance locks or durable writes remain');
    expect(existsSync(root)).toBe(false);
  }, 180_000);
});
