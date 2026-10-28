#!/usr/bin/env bun
/**
 * Cold-process first query for the scale harness (scripts/scale/run.ts).
 * Opens the brain the parent persisted under GBRAIN_HOME (its config.json
 * names the PGLite data dir or the Postgres database), runs one MCP-path
 * search as a remote caller over every scale source, and prints one JSON line:
 *   {"load_ms":N,"connect_ms":N,"query_ms":N,"results":[{"source_id":"…","slug":"…"}]}
 *
 *   GBRAIN_HOME=<dir> bun scripts/scale/cold-query.ts <query>
 */
export {};

const t0 = performance.now();
const query = process.argv[2];
if (!query) {
  console.log(JSON.stringify({ error: 'usage: GBRAIN_HOME=<dir> bun scripts/scale/cold-query.ts <query>' }));
  process.exit(2);
}
const { loadConfig, toEngineConfig } = await import('../../src/core/config.ts');
const { createEngine } = await import('../../src/core/engine-factory.ts');
const { operations } = await import('../../src/core/operations.ts');
const { SCALE_SOURCES } = await import('./fixture.ts');
const { resultHits } = await import('./gates.ts');
const loaded = performance.now();
const config = loadConfig();
if (!config) {
  console.log(JSON.stringify({ error: `no brain config under GBRAIN_HOME=${process.env.GBRAIN_HOME ?? '(unset)'}; run this only from scripts/scale/run.ts` }));
  process.exit(2);
}
const engineConfig = toEngineConfig(config);
const engine = await createEngine(engineConfig);
await engine.connect(engineConfig);
const connected = performance.now();
const ctx = {
  engine, config: { engine: engine.kind, embedding_disabled: true }, logger: { info() {}, warn() {}, error() {} }, dryRun: false,
  remote: true, sourceId: 'default', auth: { token: 'scale-cold', clientId: 'scale-cold', scopes: ['read'], allowedSources: [...SCALE_SOURCES] },
} as never;
const result = await operations.find(o => o.name === 'search')!.handler(ctx, { query, limit: 10 });
const queried = performance.now();
await engine.disconnect();
console.log(JSON.stringify({
  load_ms: Math.round(loaded - t0), connect_ms: Math.round(connected - loaded), query_ms: Math.round(queried - connected),
  results: resultHits(result),
}));
