/**
 * #5297: the persistence consumer refreshes managed roots every tick. An idle
 * refresh whose records are unchanged must not chmod the registry directory
 * or its records (chmod updates inode ctime even when the mode is already
 * right), while a drifted mode is still corrected.
 */
import { afterAll, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { recordManagedRoots } from '../src/core/persistence/root-registry.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-root-registry-5297-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const posix = process.platform !== 'win32';

test.if(posix)('an unchanged refresh leaves registry inode metadata untouched; a drifted mode is repaired', async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const brainId = randomUUID();
    const root = join(home, 'clones', 'source-example');
    mkdirSync(root, { recursive: true });
    const record = { local_path: root, source_id: 'source-example', topology_generation: 1 };
    recordManagedRoots(brainId, [record]);
    const directory = join(home, '.gbrain', 'persistence', 'managed-roots');
    const file = join(directory, readdirSync(directory).find(name => name.endsWith('.json'))!);
    const before = { dir: statSync(directory, { bigint: true }).ctimeNs, file: statSync(file, { bigint: true }).ctimeNs };
    await Bun.sleep(20);
    for (let tick = 0; tick < 3; tick++) recordManagedRoots(brainId, [record]);
    expect(statSync(directory, { bigint: true }).ctimeNs).toBe(before.dir);
    expect(statSync(file, { bigint: true }).ctimeNs).toBe(before.file);

    chmodSync(file, 0o644);
    chmodSync(directory, 0o755);
    recordManagedRoots(brainId, [record]);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });
});
