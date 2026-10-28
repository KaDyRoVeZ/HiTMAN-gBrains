import { afterAll, beforeAll, describe, test } from 'bun:test';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { exerciseRemoteLinks, remoteLinksCases } from '../helpers/remote-links-contract.ts';

(process.env.DATABASE_URL ? describe : describe.skip)('remote mention-links effect on PostgreSQL (#6007)', () => {
  let fixture: Awaited<ReturnType<typeof isolatedPersistencePostgres>>;
  beforeAll(async () => { fixture = await isolatedPersistencePostgres(process.env.DATABASE_URL!); }, 120_000);
  afterAll(async () => { await fixture?.close(); });
  for (const scenario of remoteLinksCases) test(scenario, () => exerciseRemoteLinks(fixture.engine, scenario), 60_000);
  for (const scenario of ['links', 'restart'] as const) test(`${scenario} on a managed brain`, () => exerciseRemoteLinks(fixture.engine, scenario, { managed: true }), 60_000);
});
