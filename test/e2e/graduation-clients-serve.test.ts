/**
 * Engine graduation versus the brain's serve processes and stale clients:
 * a respawned stdio or HTTP serve exits with `graduation_in_progress`, writes
 * nothing and takes no lock; a resident serve hands the source over within
 * 30 s; a stale CLI config and a stale MCP config each recover by running the
 * refusal's fix once. Split from graduation-clients.test.ts (shared steps:
 * test/helpers/graduation-clients-cases.ts).
 */
import { afterAll, describe, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  codeOf, DATABASE_URL, digestChanges, fixOf, freePort, gbrain, graduationTest, leakNeedle, mcpStdioSession, passwordOf, release, startGbrain, stateDigest, waitForEvent,
} from '../helpers/graduation-e2e.ts';
import { closeCases, findFix, fresh, runFix, staleHome } from '../helpers/graduation-clients-cases.ts';
import { expectGraduated, planAndRun } from '../helpers/graduation-scenarios.ts';

afterAll(closeCases);

describe.skipIf(!DATABASE_URL)('graduation: serve processes', () => {
  graduationTest('a serve respawned mid-copy (stdio and http) exits with graduation_in_progress, writes nothing, takes no lock', async () => {
    const c = await fresh('respawn-serve');
    const { argv, env } = await planAndRun(c, { extra: ['--batch-size', '2'] });
    const child = startGbrain(argv, { home: c.fx.home, env, hooks: { events: c.events, pause: ['batch_copied@pages'] } });
    const paused = await waitForEvent(c.events, e => e.event === 'paused', child);
    const watched = async () => {
      const d = await stateDigest(c.fx.dataDir, c.target.url);
      for (const path of [`${c.fx.dataDir}.gbrain-graduation.json`, join(c.fx.home, '.gbrain', 'graduation-manifest.json'), join(c.fx.home, '.gbrain', 'config.json')]) {
        d.files[path] = existsSync(path) ? readFileSync(path, 'utf8') : '(absent)';
      }
      return d;
    };
    const before = await watched();
    const stdio = await mcpStdioSession({ home: c.fx.home, timeoutMs: 60_000 });
    const stdioExit = await Promise.race([stdio.exited, Bun.sleep(45_000).then(() => null)]);
    expect(stdioExit).not.toBeNull();
    expect(stdioExit!.code).not.toBe(0);
    expect(`${stdioExit!.stdout}${stdioExit!.stderr}`).toContain('graduation_in_progress');
    const http = await gbrain(['serve', '--http', '--port', String(freePort())], { home: c.fx.home, timeoutMs: 60_000 });
    expect(http.code).not.toBe(0);
    expect(http.signal).toBeNull();
    expect(`${http.stdout}${http.stderr}`).toContain('graduation_in_progress');
    expect(digestChanges(before, await watched())).toEqual([]);
    release(c.events, paused.ordinal!);
    const done = await child.exited;
    expect({ code: done.code, stderr: done.code === 0 ? '' : done.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    await expectGraduated(c, 'after respawned serves');
  }, 900_000);

  graduationTest('a resident stdio serve hands the source over through the intent marker; no manual stop', async () => {
    const c = await fresh('live-serve');
    const serve = await mcpStdioSession({ home: c.fx.home, timeoutMs: 900_000 });
    const before = await serve.call('get_page', { slug: 'people/alice-example', source_id: 'default' });
    expect(before?.error).toBeUndefined();
    const { argv, env } = await planAndRun(c);
    const run = await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 });
    expect({ code: run.code, stderr: run.code === 0 ? '' : run.stderr.slice(-3000) }).toEqual({ code: 0, stderr: '' });
    const served = await Promise.race([serve.exited, Bun.sleep(30_000).then(() => null)]);
    expect(served).not.toBeNull();
    expect(`${served!.stdout}${served!.stderr}`).toContain('graduation_in_progress');
    expect(JSON.stringify(run.json)).toMatch(/restart|mcp/i);
    await expectGraduated(c, 'after live-serve hand-off', { liveWork: true });
    const relaunched = await mcpStdioSession({ home: c.fx.home });
    const after = await relaunched.call('get_page', { slug: 'people/alice-example', source_id: 'default' });
    await relaunched.close();
    expect(after?.error).toBeUndefined();
  }, 900_000);
});

describe.skipIf(!DATABASE_URL)('graduation: stale clients recover in one step', () => {
  graduationTest('a stale CLI config gets engine_graduated with a fix that works when run once', async () => {
    const c = await fresh('stale-cli');
    const { argv, env } = await planAndRun(c);
    expect((await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 })).code).toBe(0);
    const home = staleHome(c);
    const refused = await gbrain(['query', 'acme', '--json'], { home });
    expect(refused.code).not.toBe(0);
    expect(codeOf(refused.json)).toBe('engine_graduated');
    const fix = fixOf(refused.json)!;
    expect(['run', 'tell_user_to_run']).toContain(fix.next);
    expect(JSON.stringify(fix)).not.toContain(leakNeedle(passwordOf(c.target.url)));
    const fixed = await runFix(fix, home, c);
    expect({ code: fixed.code, stderr: fixed.code === 0 ? '' : fixed.stderr.slice(-1500) }).toEqual({ code: 0, stderr: '' });
    const retried = await gbrain(['get', 'people/alice-example', '--source', 'default'], { home });
    expect({ code: retried.code, stderr: retried.code === 0 ? '' : retried.stderr.slice(-1500) }).toEqual({ code: 0, stderr: '' });
    expect(retried.stdout).toContain('Alice-example');
  }, 900_000);

  graduationTest('a stale MCP server config surfaces engine_graduated through the MCP host and recovers after one fix', async () => {
    const c = await fresh('stale-mcp');
    const { argv, env } = await planAndRun(c);
    expect((await gbrain(argv, { home: c.fx.home, env, timeoutMs: 900_000 })).code).toBe(0);
    const home = staleHome(c);
    const stale = await mcpStdioSession({ home });
    const reply = await stale.call('get_page', { slug: 'people/alice-example', source_id: 'default' });
    const exited = await stale.close();
    const text = `${JSON.stringify(reply)}${exited.stdout}${exited.stderr}`;
    expect(text).toContain('engine_graduated');
    const fix = findFix(reply);
    expect(fix).not.toBeNull();
    const fixed = await runFix(fix!, home, c);
    expect(fixed.code).toBe(0);
    const relaunched = await mcpStdioSession({ home });
    const after = await relaunched.call('get_page', { slug: 'people/alice-example', source_id: 'default' });
    await relaunched.close();
    expect(after?.error).toBeUndefined();
    expect(JSON.stringify(after)).toContain('Alice-example');
  }, 900_000);
});
