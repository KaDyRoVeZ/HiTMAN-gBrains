/**
 * Child process for test/planner-stats-restart.test.ts (F4b, O-CEO-17).
 *
 *   bun test/helpers/planner-stats-child.ts <data-dir> insert <n>        insert n facts, disconnect
 *   bun test/helpers/planner-stats-child.ts <data-dir> insert-crash <n>  insert n facts, SIGKILL itself right after the commit
 *   bun test/helpers/planner-stats-child.ts <data-dir> first-read        print one JSON line about the first get_health
 */
import { writeSync } from 'node:fs';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { __testing, readPlannerStatsState } from '../../src/core/planner-stats.ts';

const [dataDir, action, count] = process.argv.slice(2);
const engine = new PGLiteEngine();
await engine.connect({ database_path: dataDir });
await engine.initSchema();
const facts = async () => (await readPlannerStatsState(engine))!.find(t => t.table === 'facts')!;

if (action === 'insert' || action === 'insert-crash') {
  await engine.executeRaw(`INSERT INTO facts (fact, source) SELECT 'restart claim ' || g, 'test' FROM generate_series(1, $1::int) g`, [Number(count)]);
  if (action === 'insert-crash') {
    writeSync(1, 'COMMITTED\n');
    process.kill(process.pid, 'SIGKILL');
    await new Promise(() => {});
  }
} else if (action === 'first-read') {
  const before = await facts();
  const events: Array<{ table: string; ms: number; during_read: boolean }> = [];
  let reading = true;
  __testing.hooks.onAnalyzed = async (_engine, event) => { events.push({ table: event.table, ms: event.ms, during_read: reading }); };
  const started = performance.now();
  await engine.getHealth();
  const readMs = performance.now() - started;
  reading = false;
  writeSync(1, `${JSON.stringify({ before, events, read_ms: readMs, after: await facts() })}\n`);
}
await engine.disconnect();
