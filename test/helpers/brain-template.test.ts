/**
 * brain-template clones are independent brains and never touch the template.
 *
 * Protects: the ENG-8 contract of test/helpers/brain-template.ts (distinct
 * brain identity per clone, independent writes, template bytes unchanged).
 * Fails when: a clone keeps the template's brain_id, source incarnation or
 * skill token, two clones share storage, or cloning or writing to a clone
 * changes the template directory.
 * Seam: none.
 */
import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { brainTemplateDir, connectTemplateBrain } from './brain-template.ts';

const scratch = mkdtempSync(join(tmpdir(), 'gbrain-template-test-'));
const engines: PGLiteEngine[] = [];
afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  rmSync(scratch, { recursive: true, force: true });
});

function treeDigest(root: string): string {
  const hash = createHash('sha256');
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      hash.update(relative(root, path));
      if (statSync(path).isDirectory()) visit(path);
      else hash.update(readFileSync(path));
    }
  };
  visit(root);
  return hash.digest('hex');
}

const identity = (engine: PGLiteEngine) => engine.executeRaw<{ brain_id: string; incarnation: string; token_secret: string }>(
  `SELECT (SELECT brain_id FROM persistence_brain WHERE singleton=1) AS brain_id,
    (SELECT incarnation::text FROM sources WHERE id='default') AS incarnation,
    (SELECT token_secret FROM shared_skill_state WHERE singleton=1) AS token_secret`).then(rows => rows[0]);

test('two concurrent clones are distinct, independent brains and the template is unchanged', async () => {
  const template = await brainTemplateDir();
  const before = treeDigest(template);
  const [a, b] = await Promise.all([connectTemplateBrain(join(scratch, 'a')), connectTemplateBrain(join(scratch, 'b'))]);
  engines.push(a, b);

  const [idA, idB] = await Promise.all([identity(a), identity(b)]);
  expect(idA.brain_id).not.toBe(idB.brain_id);
  expect(idA.incarnation).not.toBe(idB.incarnation);
  expect(idA.token_secret).not.toBe(idB.token_secret);

  await a.putPage('notes/only-in-a', { type: 'note', title: 'Only in A', compiled_truth: 'Example body.', timeline: '', frontmatter: {} });
  expect(await a.getPage('notes/only-in-a')).not.toBeNull();
  expect(await b.getPage('notes/only-in-a')).toBeNull();

  expect(treeDigest(template)).toBe(before);
}, 120_000);
