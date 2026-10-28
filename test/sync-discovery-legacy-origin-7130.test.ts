/**
 * #7130: a legacy origin recorded Git-root-relative in a source-root source (`content/a.md` under scope `content`) is read
 * for origin evidence at its real Git path, so full discovery and the dry run list its committed removal as a delete,
 * as the pass does, instead of keeping it as never committed.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { discoverManagedSync } from '../src/core/persistence/sync-discovery.ts';
import { readShadowLevel } from '../src/core/persistence/sync-pass.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
const commit = (root: string, path: string, message: string) => {
  git(root, 'add', '--', path);
  git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message);
};
const note = (name: string) => `---\ntype: concept\ntitle: ${name}\n---\n\nDistinct body of ${name}.\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`[${backend}] #7130: legacy Git-root origin in a source-root source`, () => {
    test('full discovery retains a committed removal as a delete rather than an uncommitted hold', () => managedBrain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      const original = await engine.readPageSnapshot('a', { sourceId: 'default' });
      expect(original?.page.source_path).toBe('a.md');

      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      try {
        await engine.executeRaw("UPDATE pages SET source_path='content/a.md' WHERE source_id='default' AND slug='a'");
      } finally {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      }

      git(dirname(root), 'rm', '-q', '--', 'content/a.md');
      commit(dirname(root), 'content', 'Remove the committed note');

      const level = await readShadowLevel(engine, { sourceId: 'default', full: true });
      expect(level?.paths.find(entry => entry.path === 'content/a.md')?.result.cls).toBe('delete');

      const discovery = await discoverManagedSync(engine, { ...OPTS, full: true, dryRun: true });
      expect(discovery.slugMode).toBe('source-root');
      expect(discovery.entries.filter(entry => entry.action === 'delete')).toEqual([
        expect.objectContaining({ slug: 'a', pageId: original!.page.id, sourcePath: 'content/a.md', action: 'delete' }),
      ]);
      expect(discovery.uncommittedKept ?? []).toEqual([]);
    }, {
      databaseUrl,
      setup: async ({ engine, root }) => {
        git(dirname(root), 'init', '-q');
        for (const name of ['a', 'b']) writeFileSync(join(root, `${name}.md`), note(name));
        commit(dirname(root), 'content', 'Seed the nested source');
        await engine.executeRaw(`UPDATE sources SET config=jsonb_set(config,'{slug_root_mode}','"source-root"') WHERE id='default'`);
      },
    }), 240_000);
  });
}
