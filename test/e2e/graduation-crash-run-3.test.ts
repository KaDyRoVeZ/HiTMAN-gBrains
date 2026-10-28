/**
 * Engine graduation crash custody, part of the suite documented in
 * graduation-crash-run-1.test.ts (test/helpers/graduation-crash-cases.ts).
 */
import { afterAll, expect } from 'bun:test';
import { closeCases, fresh, graduate, RUN_KILLS, runKillSuite } from '../helpers/graduation-crash-cases.ts';
import { codeOf, fixOf, gbrain, graduationTest, startGbrain, stateOf } from '../helpers/graduation-e2e.ts';
import { targetRowState, withTarget } from '../helpers/graduation-scenarios.ts';

afterAll(closeCases);

runKillSuite(RUN_KILLS.slice(11), () => {
  graduationTest('SIGKILL right after the first post-cutover write commits: the write survives, rollback lists it as user data', async () => {
    const c = await fresh('first-write-kill');
    await graduate(c);
    const writer = startGbrain(['put', 'notes/killed-after-commit', '--source', 'default'],
      { home: c.fx.home, stdin: '---\ntype: note\ntitle: Killed after commit\n---\n\nCommitted, then the writer died.\n' });
    const deadline = Date.now() + 120_000;
    for (;;) {
      const committed = await withTarget(c.target.url, t => t.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM persistence_requests
        WHERE slug='notes/killed-after-commit' AND state='committed'`));
      if (Number(committed[0].n) === 1) break;
      if (Date.now() > deadline) throw new Error('the post-cutover write never committed');
      await Bun.sleep(10);
    }
    writer.kill('SIGKILL');
    await writer.exited;
    const status = await gbrain(['migrate', '--status', '--json'], { home: c.fx.home });
    expect(stateOf(status.json)).toBe('graduated');
    const refused = await gbrain(['migrate', '--rollback-to-source', '--json'], { home: c.fx.home });
    expect(refused.code).toBe(3);
    expect(codeOf(refused.json)).toBe('graduation_rollback_writes_lost');
    expect(fixOf(refused.json)?.next).toBe('ask_user');
    expect(JSON.stringify(refused.json)).toContain('pages');
    // The refusal returned the target to authority; a normal client still writes.
    expect(await targetRowState(c.target.url)).toBe('authoritative');
    const put = await gbrain(['put', 'notes/after-refusal', '--source', 'default'], { home: c.fx.home, stdin: 'after refusal\n' });
    expect(put.code).toBe(0);
  }, 900_000);
});
