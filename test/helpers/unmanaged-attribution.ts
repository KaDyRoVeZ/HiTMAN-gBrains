import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { principalAttribution, withWriteAttribution, type WriteAttribution } from '../../src/core/persistence/attribution.ts';
import { readLocalWriter, registerLocalWriter } from '../../src/core/persistence/identity.ts';

/** Who a row or page revision names: the journal request (null for maintenance) and the principal. */
export type Actor = { request: string | null; kind: string | null; id: string | null };
export interface UnmanagedBrain { engine: BrainEngine; sourceId: string; maintenance: Actor }

/** The writer of rows that exist before the routed writer runs, so creation and last-write attribution differ. */
export const CREATOR: WriteAttribution = principalAttribution({ kind: 'application', id: 'creator-example' });
export const CREATOR_ACTOR: Actor = { request: null, kind: 'application', id: 'creator-example' };
export const UNRECORDED: Actor = { request: null, kind: null, id: null };

/**
 * An unmanaged brain (persistence_brain.enabled=false) with a fresh source and
 * a local CLI registration: routed legacy writers stamp that registration.
 */
export async function unmanagedBrain(engine: BrainEngine, sourceId = `legacy-${randomUUID().slice(0, 8)}`): Promise<UnmanagedBrain> {
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT (id) DO NOTHING', [sourceId]);
  await registerLocalWriter(engine, 'cli');
  return { engine, sourceId, maintenance: { request: null, kind: 'local_cli', id: (await readLocalWriter(engine, 'cli')).id } };
}

/** Runs fixture writes as CREATOR, so a later routed write shows up as last-write only. */
export function asCreator<T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(tx => withWriteAttribution(tx, CREATOR, () => fn(tx)));
}

export async function revisionActor(engine: BrainEngine, sourceId: string, slug: string): Promise<Actor | undefined> {
  return (await engine.executeRaw<Actor>(`SELECT revision_write_request_id::text AS request,revision_principal_kind AS kind,revision_principal_id AS id
    FROM pages WHERE source_id=$1 AND slug=$2`, [sourceId, slug]))[0];
}

export async function versionActors(engine: BrainEngine, sourceId: string, slug: string): Promise<Array<{ write: Actor; archived: Actor }>> {
  return engine.executeRaw<{ write: Actor; archived: Actor }>(`SELECT
      jsonb_build_object('request',v.write_request_id::text,'kind',v.write_principal_kind,'id',v.write_principal_id) AS write,
      jsonb_build_object('request',v.archived_write_request_id::text,'kind',v.archived_principal_kind,'id',v.archived_principal_id) AS archived
    FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY v.id`, [sourceId, slug]);
}

/** created = write_* (immutable once set), last = last_write_* (moves on every content change). */
export async function rowActors(engine: BrainEngine, table: 'facts' | 'takes' | 'timeline_entries', where: string, params: unknown[]):
  Promise<Array<{ id: number; created: Actor; last: Actor }>> {
  return engine.executeRaw<{ id: number; created: Actor; last: Actor }>(`SELECT id::int AS id,
      jsonb_build_object('request',write_request_id::text,'kind',write_principal_kind,'id',write_principal_id) AS created,
      jsonb_build_object('request',last_write_request_id::text,'kind',last_write_principal_kind,'id',last_write_principal_id) AS last
    FROM ${table} WHERE ${where} ORDER BY id`, params);
}
