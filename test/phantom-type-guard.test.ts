/**
 * Phantom redirect hardening: a phantom that declares an entity type only
 * merges into that type's directory, and short / repetitive names skip the
 * fuzzy tier (name-entropy gate).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hasNameSignal, resolvePhantomCanonical } from '../src/core/entities/resolve.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.putPage('people/mercury-example', { type: 'person' as never, title: 'Mercury Example', compiled_truth: 'A person.', timeline: '' });
  await engine.putPage('companies/acme-example', { type: 'company' as never, title: 'Acme Example', compiled_truth: 'A company.', timeline: '' });
});
afterAll(async () => { await engine.disconnect(); });

describe('resolvePhantomCanonical hardening', () => {
  test('a company phantom never merges into a person page', async () => {
    expect(await resolvePhantomCanonical(engine, 'default', 'mercury', { type: 'company' })).toBeNull();
    expect(await resolvePhantomCanonical(engine, 'default', 'mercury', { type: 'person' })).toBe('people/mercury-example');
    expect(await resolvePhantomCanonical(engine, 'default', 'mercury')).toBe('people/mercury-example');
  });
  test('a person phantom never merges into a company page', async () => {
    expect(await resolvePhantomCanonical(engine, 'default', 'acme', { type: 'person' })).toBeNull();
    expect(await resolvePhantomCanonical(engine, 'default', 'acme', { type: 'company' })).toBe('companies/acme-example');
  });
  test('name-entropy gate', () => {
    expect(hasNameSignal('ai')).toBe(false);
    expect(hasNameSignal('aaaaaaa')).toBe(false);
    expect(hasNameSignal('acme example')).toBe(true);
    expect(hasNameSignal('mercury')).toBe(true);
  });
});
