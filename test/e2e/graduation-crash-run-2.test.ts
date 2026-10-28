/**
 * Engine graduation crash custody, part of the suite documented in
 * graduation-crash-run-1.test.ts (test/helpers/graduation-crash-cases.ts).
 */
import { afterAll, expect } from 'bun:test';
import { closeCases, fresh, killAt, RUN_KILLS, runKillSuite } from '../helpers/graduation-crash-cases.ts';
import { gbrain, graduationTest } from '../helpers/graduation-e2e.ts';
import { authority, configuredEngine, withTarget } from '../helpers/graduation-scenarios.ts';

afterAll(closeCases);

runKillSuite(RUN_KILLS.slice(6, 11), () => {
  graduationTest('kill after authority, a target client writes before the routing flip, resume keeps the write and finishes routing', async () => {
    const c = await fresh('first-write-before-flip');
    await killAt(c, 'authoritative');
    expect(configuredEngine(c.fx).engine).toBe('pglite');
    const a = await authority(c);
    expect({ source: a.source, target: a.target }).toEqual({ source: false, target: true });
    // Another client already configured with the target URL (a second machine) writes first.
    const other = `${c.fx.dir}/other-client`;
    const put = await gbrain(['put', 'notes/first-post-cutover', '--source', 'default'],
      { home: other, env: { GBRAIN_DATABASE_URL: c.target.url }, stdin: '---\ntype: note\ntitle: First post-cutover write\n---\n\nWritten on the target before routing flipped.\n' });
    expect({ code: put.code, stderr: put.code === 0 ? '' : put.stderr.slice(-2000) }).toEqual({ code: 0, stderr: '' });
    const resumed = await gbrain(['migrate', '--resume', '--json'], { home: c.fx.home, timeoutMs: 600_000 });
    expect(resumed.code).toBe(0);
    expect(configuredEngine(c.fx).engine).toBe('postgres');
    await withTarget(c.target.url, async t => {
      const [page] = await t.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE source_id='default' AND slug='notes/first-post-cutover' AND deleted_at IS NULL`);
      expect(Number(page.n)).toBe(1);
    });
  }, 900_000);
});
