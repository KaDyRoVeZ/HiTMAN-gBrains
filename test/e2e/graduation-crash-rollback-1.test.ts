/**
 * Engine graduation crash custody, part of the suite documented in
 * graduation-crash-run-1.test.ts (test/helpers/graduation-crash-cases.ts).
 */
import { afterAll, expect } from 'bun:test';
import { GRADUATION_ROLLBACK_BOUNDARIES } from '../../src/core/persistence/engine-graduation.types.ts';
import { closeCases, fresh, graduate, rollbackKillSuite } from '../helpers/graduation-crash-cases.ts';
import { codeOf, fixOf, gbrain, graduationTest } from '../helpers/graduation-e2e.ts';
import { configuredEngine, rollback, targetFenceTriggers, targetRowState } from '../helpers/graduation-scenarios.ts';

afterAll(closeCases);

rollbackKillSuite(GRADUATION_ROLLBACK_BOUNDARIES.slice(0, 4), () => {
  graduationTest('a target fact withdrawal or token revocation makes rollback refuse finally, even with --yes', async () => {
    const c = await fresh('rollback-security');
    await graduate(c);
    const revoke = await gbrain(['auth', 'revoke', 'legacy-fixture-live'], { home: c.fx.home });
    expect(revoke.code).toBe(0);
    const { first } = await rollback(c, { confirm: false });
    expect(first.code).toBe(1);
    expect(codeOf(first.json)).toBe('graduation_rollback_writes_lost');
    expect(fixOf(first.json)?.next).toBe('report');
    const forced = await gbrain(['migrate', '--rollback-to-source', '--yes', '--expect', 'any', '--json'], { home: c.fx.home });
    expect(forced.code).not.toBe(0);
    expect(await targetRowState(c.target.url)).toBe('authoritative');
    expect(await targetFenceTriggers(c.target.url)).toBe(0);
    expect(configuredEngine(c.fx).engine).toBe('postgres');
  }, 900_000);
});
