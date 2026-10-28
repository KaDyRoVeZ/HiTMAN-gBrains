import { describe } from 'bun:test';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('postgres arm named by a DATABASE_URL workflow step', () => {});
