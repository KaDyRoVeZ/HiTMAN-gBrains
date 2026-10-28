/**
 * #7159 fixture: deal/person/meeting pages with frontmatter fields, one
 * private page, shared by the PGLite unit test and the engine parity E2E.
 * All names are placeholders.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { seedPage } from './keyword-paging-fixture.ts';

export const TERM = 'widget';

export const WHERE_CASES: Array<[string, Record<string, unknown>, string[]]> = [
  ['equality', { stage: 'seed' }, ['deals/acme-example', 'deals/gamma-example']],
  ['list member', { partner: 'carol-example' }, ['deals/gamma-example']],
  ['scalar or list member', { partner: 'alice-example' }, ['deals/acme-example', 'deals/gamma-example', 'meetings/standup-example']],
  ['any of', { stage: ['seed', 'series-a'] }, ['deals/acme-example', 'deals/beta-example', 'deals/gamma-example']],
  ['keys AND', { stage: 'seed', partner: 'carol-example' }, ['deals/gamma-example']],
  ['numeric string matches a number', { year: '2024' }, ['deals/acme-example']],
  ['boolean string matches a boolean', { active: 'true' }, ['deals/gamma-example']],
  ['no match', { stage: 'growth' }, []],
  ['a quote in a value is data, not SQL', { stage: "seed' OR '1'='1" }, []],
];

export const PRIVATE_WHERE = { stage: 'seed', partner: 'alice-example' };
export const PRIVATE_WHERE_REMOTE = ['deals/acme-example', 'deals/gamma-example'];
export const PRIVATE_WHERE_LOCAL = ['deals/acme-example', 'deals/gamma-example', 'deals/private-example'];

export async function seedFrontmatterCorpus(engine: BrainEngine): Promise<void> {
  await seedPage(engine, 'deals/acme-example', `Acme-example ${TERM} deal: seed round notes.`, { type: 'deal', frontmatter: { stage: 'seed', partner: 'alice-example', year: 2024 } });
  await seedPage(engine, 'deals/beta-example', `Beta-example ${TERM} deal: series A notes.`, { type: 'deal', frontmatter: { stage: 'series-a', partner: 'bob-example', year: 2025 } });
  await seedPage(engine, 'deals/gamma-example', `Gamma-example ${TERM} deal: seed extension notes.`, { type: 'deal', frontmatter: { stage: 'seed', partner: ['alice-example', 'carol-example'], active: true } });
  await seedPage(engine, 'deals/private-example', `Private-example ${TERM} deal: seed round, private.`, { type: 'deal', frontmatter: { stage: 'seed', partner: 'alice-example', visibility: 'private' } });
  await seedPage(engine, 'people/alice-example', `Alice-example reviews every ${TERM} deal.`, { type: 'person', frontmatter: { role: 'partner' } });
  await seedPage(engine, 'meetings/standup-example', `Standup about the ${TERM} roadmap.`, { type: 'meeting', frontmatter: { partner: 'alice-example' } });
}
