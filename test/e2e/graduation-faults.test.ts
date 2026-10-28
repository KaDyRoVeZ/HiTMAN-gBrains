/**
 * Engine graduation under target faults: disk full mid-copy, a password
 * rotated between the run and `--resume`, and a DDL route that names another
 * database.
 *
 * Protects: §13 Eng "Extra tests" and "Dual target routes", §13 DX "Secrets
 * never leave the private files". A target that runs out of space mid-copy
 * stops with the source untouched and authoritative, and `--resume` after
 * space returns finishes with verify green. A rotated password refuses with
 * `graduation_target_auth_failed` (ask_user, rerun with `--url-env`), the new
 * URL for the same identity resumes, and no stdout, stderr, JSON document,
 * marker or tombstone byte ever contains either password.
 * Regressions it catches: a copy that commits partial tables as complete,
 * a resume that treats the same database as a new target after rotation
 * (identity hash including the password), a password echoed into fix argv,
 * or DDL issued through a route that was never proven to be the same database.
 * Not covered elsewhere: no other suite fills a real Postgres disk.
 * The ENOSPC case starts its own pgvector/pgvector:pg16 container with a
 * 64 MiB tmpfs tablespace and needs Docker; it is skipped visibly without it.
 */
import { afterAll, describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import postgres from '#postgres';
import {
  codeOf, DATABASE_URL, fixOf, gbrain, graduationTest, graduationTestIf, hostedRoleTarget, passwordLeaks, passwordOf, startGbrain, stateOf,
  TARGET_ENV, release, waitForEvent, type GbrainResult, type TargetDb,
} from '../helpers/graduation-e2e.ts';
import { authority, expectGraduated, legacyCase, planAndRun, scratchRoot, targetRowState, type Case } from '../helpers/graduation-scenarios.ts';

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
  rmSync(scratchRoot, { recursive: true, force: true });
});

const docker = (...args: string[]) => {
  const r = Bun.spawnSync(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode, out: r.stdout.toString().trim(), err: r.stderr.toString() };
};
const dockerAvailable = !!Bun.which('docker') && docker('info', '--format', '{{.ServerVersion}}').code === 0;

/** A disposable pg16 server whose target database lives on a 64 MiB tmpfs tablespace. */
async function tmpfsTarget(): Promise<TargetDb & { container: string; fill(leaveKb: number): void; drain(): void }> {
  const container = `gbrain-graduation-enospc-${randomUUID().slice(0, 8)}`;
  const started = docker('run', '-d', '--name', container, '--tmpfs', '/small:rw,size=64m,mode=1777', '-e', 'POSTGRES_PASSWORD=postgres',
    '-e', 'POSTGRES_DB=gbrain_test', '-p', '127.0.0.1::5432', 'pgvector/pgvector:pg16');
  if (started.code !== 0) throw new Error(`docker run: ${started.err}`);
  cleanups.push(async () => { docker('rm', '-f', container); });
  const port = docker('port', container, '5432/tcp').out.split(':').pop();
  for (let i = 0; i < 120 && docker('exec', container, 'pg_isready', '-U', 'postgres').code !== 0; i++) await Bun.sleep(500);
  await Bun.sleep(1000);
  docker('exec', '-u', 'postgres', container, 'mkdir', '-p', '/small/ts');
  const admin = `postgresql://postgres:postgres@127.0.0.1:${port}/gbrain_test`;
  const database = 'gbrain_test_graduation_enospc';
  const sql = postgres(admin, { max: 1, prepare: false, onnotice: () => {} });
  try {
    await sql.unsafe(`CREATE TABLESPACE small LOCATION '/small/ts'`);
    await sql.unsafe(`CREATE DATABASE ${database} TABLESPACE small`);
  } finally { await sql.end(); }
  return {
    container, database, admin, url: `postgresql://postgres:postgres@127.0.0.1:${port}/${database}`,
    fill(leaveKb: number) {
      const r = docker('exec', container, 'sh', '-c',
        `avail=$(df -k /small | tail -1 | awk '{print $4}'); fallocate -l $(( (avail - ${leaveKb}) * 1024 )) /small/ballast && df -k /small | tail -1`);
      if (r.code !== 0) throw new Error(`fill: ${r.err}`);
    },
    drain() { docker('exec', container, 'rm', '-f', '/small/ballast'); },
    close: async () => { docker('rm', '-f', container); },
  };
}

describe.skipIf(!DATABASE_URL)('graduation: target faults', () => {
  graduationTestIf(!dockerAvailable)('ENOSPC mid-copy stops with the source authoritative; resume after space returns graduates', async () => {
    const target = await tmpfsTarget();
    const c = await legacyCase('enospc', target);
    const { argv, env } = await planAndRun(c);
    const child = startGbrain(argv, { home: c.fx.home, env, hooks: { events: c.events, pause: ['target_fenced'] } });
    const paused = await waitForEvent(c.events, e => e.event === 'paused', child);
    target.fill(128);
    release(c.events, paused.ordinal!);
    const failed = await child.exited;
    expect(failed.code).not.toBe(0);
    expect(`${failed.stdout}${failed.stderr}`).toMatch(/No space left on device|disk_full|53100|could not extend/i);
    const a = await authority(c);
    expect(a.target).toBe(false);
    expect(['copying', 'verify_failed', null]).toContain(await targetRowState(c.target.url));
    const status = await gbrain(['migrate', '--status', '--json'], { home: c.fx.home });
    expect(status.code).toBe(0);
    expect(stateOf(status.json)).not.toBe('graduated');

    target.drain();
    const resumed = await gbrain(['migrate', '--resume', '--json'], { home: c.fx.home, timeoutMs: 900_000 });
    expect({ code: resumed.code, stderr: resumed.code === 0 ? '' : resumed.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    await expectGraduated(c, 'after ENOSPC resume');
  }, 900_000);

  graduationTest('password rotated between the run and --resume: typed refusal, then --url-env resumes; no byte leaks either password', async () => {
    const hosted = await hostedRoleTarget();
    cleanups.push(() => hosted.close());
    const c = await legacyCase('rotation', hosted);
    const oldUrl = hosted.url;
    const results: GbrainResult[] = [];
    const { argv, env, plan } = await planAndRun(c, { url: oldUrl });
    results.push(plan);
    const child = startGbrain(argv, { home: c.fx.home, env, hooks: { events: c.events, pause: ['table_copied@pages'] } });
    await waitForEvent(c.events, e => e.event === 'paused', child);
    child.kill('SIGKILL');
    results.push(await child.exited);

    const newUrl = await hosted.rotatePassword();
    const refused = await gbrain(['migrate', '--resume', '--json'], { home: c.fx.home });
    results.push(refused);
    expect(refused.code).toBe(1);
    expect(codeOf(refused.json)).toBe('graduation_target_auth_failed');
    expect(fixOf(refused.json)?.next).toBe('ask_user');
    expect(JSON.stringify(fixOf(refused.json))).toContain('--url-env');

    const resumed = await gbrain(['migrate', '--resume', '--url-env', TARGET_ENV, '--json'], { home: c.fx.home, env: { [TARGET_ENV]: newUrl }, timeoutMs: 900_000 });
    results.push(resumed);
    expect({ code: resumed.code, stderr: resumed.code === 0 ? '' : resumed.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    const status = await gbrain(['migrate', '--status', '--json'], { home: c.fx.home });
    results.push(status);
    await expectGraduated({ ...c, target: { ...hosted, url: newUrl } }, 'after rotation');
    expect(passwordLeaks(passwordOf(oldUrl), results, c.fx.dir)).toEqual([]);
    expect(passwordLeaks(passwordOf(newUrl), results, c.fx.dir)).toEqual([]);
    // The hosted role cannot SET session_replication_role, so the receipt names the fallback.
    expect(JSON.stringify(status.json)).toContain('disable_trigger');
  }, 900_000);

  graduationTest('a DDL route that names another database refuses before any DDL', async () => {
    const c = await legacyCase('ddl-mismatch');
    const elsewhere = await legacyCase('ddl-elsewhere');
    cleanups.push(() => c.target.close(), () => elsewhere.target.close());
    const plan = await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--plan', '--json'],
      { home: c.fx.home, env: { [TARGET_ENV]: c.target.url, GBRAIN_DIRECT_DATABASE_URL: elsewhere.target.url } });
    const run = plan.code === 0
      ? await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--yes', '--expect', String(plan.json?.plan_hash ?? plan.json?.planHash), '--json'],
        { home: c.fx.home, env: { [TARGET_ENV]: c.target.url, GBRAIN_DIRECT_DATABASE_URL: elsewhere.target.url } })
      : plan;
    expect(codeOf(run.json)).toBe('graduation_target_ddl_unreachable');
    expect(fixOf(run.json)?.next).toBe('ask_user');
    expect(await targetRowState(c.target.url)).toBeNull();
    expect(await targetRowState(elsewhere.target.url)).toBeNull();
    const a = await authority(c);
    expect(a.source).toBe(true);
  }, 600_000);
});
