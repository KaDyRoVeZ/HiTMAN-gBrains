import { expect } from 'bun:test';

// Save-and-restore reads and assertions are not Postgres arms.
const prev = process.env.DATABASE_URL;
delete process.env.DATABASE_URL;
if (prev !== undefined) process.env.DATABASE_URL = prev;
expect(process.env.DATABASE_URL).toBeUndefined();
