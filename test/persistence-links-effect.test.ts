import { afterAll, beforeAll, describe, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { exerciseRemoteLinks, remoteLinksCases } from './helpers/remote-links-contract.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); await resetPgliteState(engine); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

describe('remote mention-links effect (#6007)', () => {
  for (const scenario of remoteLinksCases) test(scenario, () => exerciseRemoteLinks(engine, scenario), 60_000);
});
