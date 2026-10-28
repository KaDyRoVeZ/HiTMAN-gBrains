/**
 * Engine graduation crash custody, part of the suite documented in
 * graduation-crash-run-1.test.ts (test/helpers/graduation-crash-cases.ts).
 */
import { afterAll, expect } from 'bun:test';
import { GRADUATION_ROLLBACK_BOUNDARIES } from '../../src/core/persistence/engine-graduation.types.ts';
import { closeCases, fresh, graduate, rollbackKillSuite } from '../helpers/graduation-crash-cases.ts';
import { graduationTest } from '../helpers/graduation-e2e.ts';
import { authority, rollback, targetFenceTriggers, withTarget } from '../helpers/graduation-scenarios.ts';

afterAll(closeCases);

rollbackKillSuite(GRADUATION_ROLLBACK_BOUNDARIES.slice(4), () => {
  graduationTest('rollback with no post-cutover writes restores the source exactly and leaves the target fenced', async () => {
    const c = await fresh('rollback-clean');
    await graduate(c);
    const { first, confirmed } = await rollback(c);
    expect((confirmed ?? first).code).toBe(0);
    const a = await authority(c);
    expect({ source: a.source, target: a.target }).toEqual({ source: true, target: false });
    expect(await targetFenceTriggers(c.target.url)).toBeGreaterThan(0);
    const blocked = await withTarget(c.target.url, t => t.executeRaw(`INSERT INTO config(key,value) VALUES('graduation.stray','x')`).then(() => 'written', e => String(e)));
    expect(blocked).toContain('graduation');
  }, 900_000);
});
