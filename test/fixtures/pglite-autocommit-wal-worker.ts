/**
 * Child for test/pglite-checkpoint-guard.test.ts: writes about 200 MB of WAL
 * through autocommit `executeRaw` statements (never engine.transaction()) into
 * a file-backed PGLite whose max_wal_size is 64 MB, so the automatic
 * checkpoint trigger is crossed many times. Before the guard covered
 * autocommit writes, PGLite ran that checkpoint inline inside the crossing
 * write and spun forever (#5449), so the parent kills this child on a timeout.
 * argv[2]: an empty directory for the brain. Prints `done <batches>`.
 */
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

const path = join(process.argv[2]!, 'brain.pglite');
let engine = new PGLiteEngine();
await engine.connect({ engine: 'pglite', database_path: path } as never);
await engine.executeRaw("ALTER SYSTEM SET max_wal_size = '64MB'");
await engine.executeRaw('CREATE TABLE wal_bulk (id int, v text)');
await engine.disconnect();
engine = new PGLiteEngine();
await engine.connect({ engine: 'pglite', database_path: path } as never);
const batches = 200;
for (let i = 0; i < batches; i++) {
  await engine.executeRaw("INSERT INTO wal_bulk SELECT g, md5(random()::text) || repeat('x', 900) FROM generate_series(1, 1000) g");
}
await engine.disconnect();
console.log(`done ${batches}`);
process.exit(0);
