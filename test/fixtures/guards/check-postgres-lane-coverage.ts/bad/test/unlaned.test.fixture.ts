import { test } from 'bun:test';

// A DATABASE_URL-gated Postgres arm that no Postgres lane names.
test.skipIf(!process.env.DATABASE_URL)('postgres arm', () => {});
