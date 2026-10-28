import { beforeAll } from 'bun:test';
import { isolatedPersistencePostgres } from '../../../../../helpers/persistence-postgres.ts';

beforeAll(async () => { if (process.env.DATABASE_URL) await isolatedPersistencePostgres(process.env.DATABASE_URL); });
