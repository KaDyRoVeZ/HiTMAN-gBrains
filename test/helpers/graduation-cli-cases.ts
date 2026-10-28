/**
 * Shared by the graduation-cli*.test.ts suites, one agent-workflow suite split
 * into files so a CI queue can run them side by side (each file is its own
 * process with its own scratch root and fixture cache):
 *   graduation-cli.test.ts               agent workflow, target emptiness and --force
 *   graduation-cli-topologies.test.ts    PgBouncer, hosted-style role, forced bypass
 *   graduation-cli-history.test.ts       1k-page history round trip
 *   graduation-cli-zero-mutation-N.test.ts  --plan/--status polled at every custody
 *     boundary; file N of ZERO_MUTATION_PARTS probes the boundaries whose pause
 *     ordinal is N modulo the part count, so together they probe every one.
 */
import { afterAll, describe, expect } from 'bun:test';
import { rmSync } from 'node:fs';
import { DATABASE_URL, digestChanges, gbrain, graduationTest, release, startGbrain, stateDigest, TARGET_ENV, waitForEvent } from './graduation-e2e.ts';
import { expectGraduated, legacyCase, planAndRun, scratchRoot, type Case } from './graduation-scenarios.ts';

export const ZERO_MUTATION_PARTS = 3;

/** Fresh legacy cases whose targets (and any registered cleanup) are torn down after the file. */
export function useGraduationCases() {
  const cleanups: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
    rmSync(scratchRoot, { recursive: true, force: true });
  });
  async function fresh(name: string, target?: Case['target']): Promise<Case> {
    const c = await legacyCase(name, target);
    cleanups.push(() => c.target.close());
    return c;
  }
  return { cleanups, fresh };
}

/**
 * One graduation paused at every custody boundary and SIGKILLed at `verified`;
 * this part probes its share of the pauses, then the post-crash state.
 */
export function zeroMutationSuite(part: number): void {
  const { fresh } = useGraduationCases();
  describe.skipIf(!DATABASE_URL)('graduation: --plan and --status are zero-mutation', () => {
    graduationTest(`polled at every custody boundary (part ${part} of ${ZERO_MUTATION_PARTS}) and after a crash, neither changes a byte or a row`, async () => {
      const c = await fresh('zero-mutation');
      const { argv, env } = await planAndRun(c);
      const child = startGbrain(argv, { home: c.fx.home, env, hooks: { events: c.events, pause: ['*'] } });
      const seen: string[] = [];
      const probe = async (label: string) => {
        const before = await stateDigest(c.fx.dir, c.target.url);
        const status = await gbrain(['migrate', '--status', '--json'], { home: c.fx.home });
        expect({ label, code: status.code }).toEqual({ label, code: 0 });
        await gbrain(['migrate', '--to', 'postgres', '--url-env', TARGET_ENV, '--plan', '--json'], { home: c.fx.home, env });
        // Not the poll's writes: the paused run's own kernel-lock heartbeat (.gbrain-lock/lock, every 30 s) and Bun's runtime install cache under the test HOME.
        const changes = digestChanges(before, await stateDigest(c.fx.dir, c.target.url))
          .filter(change => !change.includes('boundary-events.jsonl') && !change.includes('.gbrain-lock/lock') && !change.includes('/.bun/install/cache/'));
        expect({ label, changes }).toEqual({ label, changes: [] });
      };
      for (let ordinal = 1; ; ordinal++) {
        const paused = await waitForEvent(c.events, e => e.event === 'paused' && e.ordinal === ordinal, child).catch(() => null);
        if (!paused) break;
        seen.push(paused.boundary);
        if (ordinal % ZERO_MUTATION_PARTS === part % ZERO_MUTATION_PARTS) await probe(`${paused.boundary}#${ordinal}`);
        if (paused.boundary === 'verified') {
          child.kill('SIGKILL');
          await child.exited;
          await probe('after a SIGKILL at verified');
          break;
        }
        release(c.events, ordinal);
      }
      expect(seen).toEqual(expect.arrayContaining(['quiesced', 'drained', 'target_fenced', 'table_copied', 'copied', 'verified']));
      expect((await gbrain(['migrate', '--resume', '--json'], { home: c.fx.home, timeoutMs: 900_000 })).code).toBe(0);
      await expectGraduated(c, 'after zero-mutation polling');
    }, 1_200_000);
  });
}
