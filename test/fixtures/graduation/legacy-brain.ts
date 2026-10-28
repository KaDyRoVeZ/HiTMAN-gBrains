/**
 * Independent legacy fixture for engine graduation (PGLite -> Postgres).
 *
 * Hand-built SQL on a fresh `initSchema()` brain, with expected outcomes
 * written by hand in `expected.json` beside this file. It never calls the
 * history generator (`scripts/persistence/history-fixture.ts`); the two
 * fixtures cross-check each other.
 *
 * Build order matters and mirrors how real brains age:
 * 1. Legacy rows while managed persistence is still off (`enabled=false`, so
 *    `managed_writer_guard` is inert): unattributed pages, versions, facts,
 *    takes and timeline rows; fact withdrawals with a page overlay; loop
 *    mutes; decide proposals; take supersession; revoked and live access
 *    tokens; an OAuth client and token; byte-heavy raw_data/files/jsonb
 *    rows; text keys that differ by case, '-' versus '_' and non-ASCII.
 * 2. A managed worktree with a host binding (`claimWorktree`) and activation
 *    (`activatePersistence`), then three committed page writes through the
 *    real `put_page` handler so their effects are real rows.
 * 3. Derived-work states edited in by hand: a failed embedding effect, a
 *    delayed effect, an orphan `running` effect, a stale `active` minion job
 *    lease and an orphan cycle lock.
 * 4. A queued request admitted through `admitWrite` with no owner running.
 *    Its full `WriteAdmission` (including `callerIntent`, which
 *    `persistence_requests` does not store) is returned and written to
 *    `<root>/queued-admission.json` so a replay probe in another process
 *    can resubmit it.
 *
 * Preconditions: the engine is connected and `initSchema()`d but not
 * activated, and the process runs under an isolated `GBRAIN_HOME` (the host
 * identity and worktree locks live there). Synthetic data only.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../../../src/core/engine.ts';
import type { GBrainConfig } from '../../../src/core/config.ts';
import { claimWorktree, getWorktreeBinding } from '../../../src/core/persistence/ownership.ts';
import { activatePersistence } from '../../../src/core/persistence/activation.ts';
import { admitWrite, type WriteAdmission } from '../../../src/core/persistence/journal.ts';
import { submissionAuthority } from '../../../src/core/persistence/authority.ts';
import { requestPrincipalForContext } from '../../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../../src/core/persistence/service.ts';
import { localHostId } from '../../../src/core/persistence/identity.ts';
import { MinionQueue } from '../../../src/core/minions/queue.ts';
import { contextFor, descriptor, executeOp, type World } from '../../../scripts/persistence/ops.ts';

export const LEGACY_FIXTURE_VERSION = 1;
export const EXPECTED_PATH = join(import.meta.dir, 'expected.json');

/** Synthetic bearer secrets, valid only inside a scratch fixture brain. */
export const LEGACY_SECRETS = {
  liveToken: 'gbrain-legacy-fixture-live-token',
  revokedToken: 'gbrain-legacy-fixture-revoked-token',
  oauthAccess: 'gbrain-legacy-fixture-oauth-access',
  oauthClientSecret: 'gbrain-legacy-fixture-oauth-client-secret',
} as const;

export const LEGACY_IDS = {
  archiveIncarnation: '00000000-0000-4000-8000-00000000a001',
  wikiIncarnation: '00000000-0000-4000-8000-00000000a002',
  queuedRequestId: '00000000-0000-4000-8000-0000000000a1',
  managedRequestIds: ['00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000b2', '00000000-0000-4000-8000-0000000000b3'],
  orphanExecutionToken: '00000000-0000-4000-8000-0000000000c1',
  revokedWriterId: '00000000-0000-4000-8000-0000000000d1',
  revision: (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
} as const;

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

export interface LegacyBrainFixture {
  root: string;
  hostId: string;
  wikiRoot: string;
  worktreeId: string;
  /** The full admission of the queued request, callerIntent included. */
  queued: WriteAdmission;
  /** Request ids of the three managed put_page writes, in order. */
  managedRequestIds: readonly string[];
  /** persistence_effects ids: [failed embedding, delayed embedding, orphan running embedding]. */
  effectIds: { failed: string; delayed: string; orphanRunning: string };
  staleJobId: number;
  embeddingDims: { content_chunks: number; facts: number };
}

export interface LegacyExpected {
  version: number;
  secrets: typeof LEGACY_SECRETS;
  source: {
    counts: Record<string, number>;
    pages: Record<string, { source_id: string; generation: number; deleted: boolean; attributed: boolean; projection_queued: boolean }>;
    facts: Record<string, { expired_at: string | null; superseded_by_fact: string | null; attributed: boolean }>;
    takes: { row_num: number; active: boolean; superseded_by: number | null }[];
    withdrawal_subjects_c_order: string[];
    config_keys_c_order: string[];
    projection_slugs_c_order: string[];
    oauth_client_ids_c_order: string[];
    overlay: { slug: string; stored_contains: string[]; snapshot_contains: string[]; snapshot_excludes: string[] };
    effects: Record<'failed' | 'delayed' | 'orphan_running', { state: string; attempts: number; next_attempt_at?: string; error_code?: string | null; execution_token: string | null; claim_expires_at: string | null }>;
    stale_job: { status: string; claim_generation: number; lock_token: string; lock_until: string };
    queued_request: { request_id: string; state: string; slug: string; source_id: string };
    managed_requests: { state: string; count: number };
    tokens: Record<string, { revoked: boolean }>;
    local_writers: { live: number; revoked: number };
    bytes: { raw_data_min: number; files_metadata_min: number; minion_data_min: number; frontmatter_min: number };
    cycle_locks: number;
    embeddings: { chunks: number; facts: number };
    brain: { enabled: boolean };
  };
  target: {
    counts: Record<string, number>;
    absent_tables: string[];
    effects: Record<'failed' | 'delayed' | 'orphan_running', { state: string; attempts: number; next_attempt_at?: string; execution_token: string | null; claim_expires_at: string | null }>;
    stale_job: { status: string; claim_generation: number; lock_token: string | null; lock_until: string | null };
    worktree_heartbeat_at: string | null;
    queued_request: { state: string; replay_creates_row: boolean };
    tokens_authorize: Record<string, boolean>;
    brain: { enabled: boolean; brain_id_equals_source: boolean };
    unchanged_tables: string[];
  };
}

export function loadLegacyExpected(): LegacyExpected {
  return JSON.parse(readFileSync(EXPECTED_PATH, 'utf8')) as LegacyExpected;
}

function gitRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode) throw new Error(`git ${args[0]}: ${result.stderr.toString()}`);
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Legacy Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(dir, 'README.md'), '# Legacy fixture wiki\n');
  git('add', 'README.md'); git('commit', '-q', '-m', 'Initial');
  const hook = join(dir, '.git', 'hooks', 'post-commit');
  writeFileSync(hook, '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n');
  chmodSync(hook, 0o755);
}

/** Deterministic vector text with full float precision, so a lossy round trip shows in the digest. */
export function fixtureVector(dims: number, salt: number): string {
  return `[${Array.from({ length: dims }, (_, i) => Math.fround(Math.sin((i + 1) * (salt + 0.37)) / 3).toString()).join(',')}]`;
}

async function vectorDims(engine: BrainEngine, table: string, column: string): Promise<number> {
  const [row] = await engine.executeRaw<{ t: string }>(
    `SELECT format_type(a.atttypid, a.atttypmod) AS t FROM pg_attribute a WHERE a.attrelid=$1::regclass AND a.attname=$2`, [table, column]);
  const match = /\((\d+)\)/.exec(row?.t ?? '');
  assert(match, `legacy fixture: ${table}.${column} has no fixed vector dimension (${row?.t})`);
  return Number(match[1]);
}

/** A ~size-byte JSON value mixing nesting, unicode, escapes and numbers whose text form differs across renderers. */
export function heavyJson(size: number, salt: string): unknown {
  const items: unknown[] = [];
  let bytes = 0;
  for (let i = 0; bytes < size; i++) {
    const item = { i, salt, text: `entry ${i} — naïve café 東京 \u{1F9E0} "quoted" back\\slash\ttab`, n: [1e-7, 12345678901234, -0.5, 3.14159265358979], nested: { z: i % 2 === 0, a: null, m: `${salt}-${i}` } };
    items.push(item);
    bytes += JSON.stringify(item).length;
  }
  return { kind: 'legacy-fixture-heavy', salt, items };
}

/** Build the legacy brain. See the module comment for preconditions. */
export async function buildLegacyBrain(engine: BrainEngine, { root }: { root: string }): Promise<LegacyBrainFixture> {
  assert(process.env.GBRAIN_HOME, 'legacy fixture: run under an isolated GBRAIN_HOME');
  const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  assert.equal(brain.enabled, false, 'legacy fixture: start from a fresh, not yet activated schema');
  const sql = (text: string, params: unknown[] = []) => engine.executeRaw(text, params);
  const chunkDims = await vectorDims(engine, 'content_chunks', 'embedding');
  const factDims = await vectorDims(engine, 'facts', 'embedding');

  // ── 1. Legacy rows (managed persistence off) ────────────────────────────────
  await sql(`INSERT INTO sources(id,name,local_path,incarnation,config) VALUES('legacy-archive','Legacy archive',NULL,$1::uuid,$2::text::jsonb)`,
    [LEGACY_IDS.archiveIncarnation, JSON.stringify({ note: 'legacy source without a checkout', tags: ['ünïcode', 'x'] })]);

  for (const [key, value] of [['graduation_fixture.Mixed-Key', 'upper'], ['graduation_fixture.mixed-key', 'hyphen'],
    ['graduation_fixture.mixed_key', 'underscore'], ['graduation_fixture.mïxed-key', 'non-ascii']]) {
    await sql('INSERT INTO config(key,value) VALUES($1,$2)', [key, value]);
  }

  const frontmatter = { type: 'company', title: 'Acme Example', aliases: ['acme', 'ACME', 'ácme'], metrics: { mrr: 50000, ratio: 1e-7, big: 12345678901234 },
    notes: heavyJson(64 * 1024, 'frontmatter') };
  const page = async (n: number, sourceId: string, slug: string, title: string, body: string, opts: { projected?: boolean; deleted?: boolean; fm?: unknown } = {}) => {
    const revision = LEGACY_IDS.revision(n);
    const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO pages(source_id,slug,type,title,compiled_truth,timeline,frontmatter,
      knowledge_revision,text_projection_revision,deleted_at,created_at,updated_at)
      VALUES($1,$2,'note',$3,$4,'',$5::text::jsonb,$6::uuid,$7::uuid,$8::timestamptz,'2025-11-01T10:00:00Z','2025-11-01T10:00:00Z') RETURNING id`,
    [sourceId, slug, title, body, JSON.stringify(opts.fm ?? { title }), revision, opts.projected ? revision : null,
      opts.deleted ? '2026-01-15T00:00:00Z' : null]);
    return Number(row.id);
  };
  const aliceBody = ['Alice-example is a fixture person.', '', '## Facts', '', '<!--- gbrain:facts:begin -->', '',
    '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |',
    '|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|',
    '| 1 | Alice-example works at acme-example. | fact | 1.0 | private | medium | 2025-11-05 |  | legacy-import |  |',
    '| 2 | Alice-example prefers green tea. | fact | 1.0 | private | medium | 2025-11-05 |  | legacy-import |  |',
    '<!--- gbrain:facts:end -->', ''].join('\n');
  const alice = await page(1, 'default', 'people/alice-example', 'Alice Example', aliceBody);
  await page(2, 'default', 'people/alice_example', 'Alice Example (underscore)', 'A second page whose slug differs only by underscore.\n');
  await page(3, 'default', 'people/älice-example', 'Älice Example', 'A page whose slug differs only by a non-ASCII letter.\n');
  const acme = await page(4, 'default', 'companies/acme-example', 'Acme Example', 'Acme-example builds widgets.\n', { projected: true, fm: frontmatter });
  await page(5, 'default', 'notes/legacy-deleted', 'Legacy deleted', 'Soft-deleted before graduation.\n', { projected: true, deleted: true });
  await page(6, 'legacy-archive', 'notes/archived-note', 'Archived note', 'Lives in a source without a checkout.\n', { projected: true });

  // Two legacy edits of the Alice page: version rows without attribution, and a non-monotonic generation.
  for (const [n, extra] of [[7, 'Edited once.'], [8, 'Edited twice.']] as const) {
    await sql(`INSERT INTO page_versions(page_id,compiled_truth,frontmatter,snapshot_at,knowledge_revision,title,type)
      SELECT id,compiled_truth,frontmatter,'2025-12-0${n - 6}T00:00:00Z',knowledge_revision,title,type FROM pages WHERE id=$1`, [alice]);
    await sql(`UPDATE pages SET compiled_truth=$2, knowledge_revision=$3::uuid, updated_at='2025-12-0${n - 6}T00:00:00Z' WHERE id=$1`,
      [alice, `${aliceBody}${extra}\n`, LEGACY_IDS.revision(n)]);
  }

  await sql(`INSERT INTO tags(page_id,tag) VALUES($1,'company'),($1,'Legacy'),($1,'legacy')`, [acme]);
  await sql(`INSERT INTO timeline_entries(page_id,date,source,summary,detail) VALUES($1,'2025-10-01','legacy','Founded','Acme-example was founded.'),
    ($1,'2026-01-10','legacy','Seed round','Raised from fund-a.')`, [acme]);

  // Takes: row 1 superseded by row 2 (supersession is by row number, no FK).
  await sql(`INSERT INTO takes(page_id,row_num,claim,kind,holder,weight,superseded_by,active,created_at,updated_at)
    VALUES($1,1,'Acme-example will raise a seed round.','take','world',0.6,2,false,'2025-11-03T00:00:00Z','2026-01-10T00:00:00Z'),
          ($1,2,'Acme-example raised a seed round from fund-a.','take','world',0.9,NULL,true,'2026-01-10T00:00:00Z','2026-01-10T00:00:00Z')`, [acme]);

  // Withdrawals first, so facts_preserve_withdrawal stamps the matching fact on insert (the overlay case).
  const withdrawn = 'Alice-example prefers green tea.';
  await sql(`INSERT INTO fact_withdrawals(source_id,visibility,subject,fact_hash,withdrawn_at) VALUES
    ('default','private','people/alice-example',gbrain_fact_fingerprint($1),'2026-02-01T00:00:00Z'),
    ('default','private','People/Alice-Example',gbrain_fact_fingerprint('Case-variant subject withdrawal.'),'2026-02-02T00:00:00Z'),
    ('default','private','people/alice_example',gbrain_fact_fingerprint('Underscore subject withdrawal.'),'2026-02-03T00:00:00Z'),
    ('default','private','people/älice-example',gbrain_fact_fingerprint('Non-ASCII subject withdrawal.'),'2026-02-04T00:00:00Z'),
    ('default','world','*',gbrain_fact_fingerprint('A world-wide withdrawal.'),'2026-02-05T00:00:00Z')`, [withdrawn]);
  const fact = async (text: string, entity: string | null, visibility: string, embedding: string | null) => {
    const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,entity_slug,fact,visibility,source,valid_from,created_at,embedding,embedded_at)
      VALUES('default',$1,$2,$3,'legacy-import','2025-11-05T00:00:00Z','2025-11-05T00:00:00Z',$4::halfvec,$5::timestamptz) RETURNING id`,
    [entity, text, visibility, embedding, embedding ? '2025-11-06T00:00:00Z' : null]);
    return Number(row.id);
  };
  const fTea = await fact(withdrawn, 'people/alice-example', 'private', null);
  const fWorks = await fact('Alice-example works at acme-example.', 'people/alice-example', 'private', null);
  const fSeed = await fact('Acme-example raised a seed round from fund-a.', 'companies/acme-example', 'world', fixtureVector(factDims, 2));
  const fOld = await fact('Acme-example is pre-seed.', 'companies/acme-example', 'world', null);
  await sql('UPDATE facts SET superseded_by=$1, expired_at=$3::timestamptz WHERE id=$2', [fSeed, fOld, '2026-01-10T00:00:00Z']);

  await sql(`INSERT INTO decide_proposals(source_id,sweep_id,pair_index,new_fact_id,old_fact_id,p_supersede,threshold,proposal_floor,model_resolved,status,decided_at,created_at)
    VALUES('default','legacy-sweep-1',0,$1,$2,0.93,0.8,0.5,'fixture:decide','accepted','2026-01-11T00:00:00Z','2026-01-10T12:00:00Z'),
          ('default','legacy-sweep-1',1,$3,$4,0.61,0.8,0.5,'fixture:decide','pending',NULL,'2026-01-10T12:00:00Z')`, [fSeed, fOld, fWorks, fTea]);

  await sql(`INSERT INTO loop_suppressions(source_id,kind,value,created_at) VALUES('default','sender','alice@example.com','2026-01-20T00:00:00Z'),
    ('default','thread','thread-legacy-0001','2026-01-21T00:00:00Z')`);
  await sql(`INSERT INTO open_loops(source_id,dedup_key,loop_type,counterparty_slug,summary,evidence,status,detector,opened_at,last_activity_at,closed_at,closed_by)
    VALUES('default','legacy-loop-1','commitment_owed_by_me','people/alice-example','Send the deck to alice-example.',$1::text::jsonb,'dropped','manual',
      '2026-01-05T00:00:00Z','2026-01-06T00:00:00Z','2026-01-21T00:00:00Z','user')`, [JSON.stringify([{ quote: 'I will send the deck — Friday.', at: '2026-01-05' }])]);

  await sql(`INSERT INTO access_tokens(name,token_hash,scopes,created_at,revoked_at) VALUES
    ('legacy-fixture-live',$1,ARRAY['read','write'],'2025-10-01T00:00:00Z',NULL),
    ('legacy-fixture-revoked',$2,ARRAY['read'],'2025-10-01T00:00:00Z','2026-03-01T00:00:00Z')`,
  [sha256(LEGACY_SECRETS.liveToken), sha256(LEGACY_SECRETS.revokedToken)]);
  await sql(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,grant_types,scope,client_id_issued_at,source_id,created_at,deleted_at) VALUES
    ('legacy-fixture-client',$1,'Legacy fixture agent',ARRAY['client_credentials'],'read write',1760000000,'default','2025-10-02T00:00:00Z',NULL),
    ('Legacy-Fixture-Client',$1,'Case-variant deleted client',ARRAY['client_credentials'],'read',1760000000,'default','2025-10-02T00:00:00Z','2026-01-01T00:00:00Z')`,
  [sha256(LEGACY_SECRETS.oauthClientSecret)]);
  await sql(`INSERT INTO oauth_tokens(token_hash,token_type,client_id,scopes,expires_at,created_at)
    VALUES($1,'access','legacy-fixture-client',ARRAY['read','write'],4102444800,'2025-10-02T00:00:00Z')`, [sha256(LEGACY_SECRETS.oauthAccess)]);

  await sql(`INSERT INTO raw_data(page_id,source,data,fetched_at) VALUES($1,'legacy-crawler',$2::text::jsonb,'2025-11-07T00:00:00Z')`,
    [acme, JSON.stringify(heavyJson(2 * 1024 * 1024, 'raw'))]);
  await sql(`INSERT INTO files(source_id,page_slug,page_id,filename,storage_path,mime_type,size_bytes,content_hash,metadata,created_at) VALUES
    ('default','companies/acme-example',$1,'deck — final (v2).pdf','default/companies/acme-example/deck-final-v2.pdf','application/pdf',1048576,$2,$3::text::jsonb,'2025-11-08T00:00:00Z'),
    ('default',NULL,NULL,'Ünïcode name.txt','default/orphans/unicode-name.txt','text/plain',42,$4,$5::text::jsonb,'2025-11-08T00:00:00Z')`,
  [acme, sha256('deck'), JSON.stringify(heavyJson(256 * 1024, 'files-a')), sha256('unicode'), JSON.stringify(heavyJson(256 * 1024, 'files-b'))]);


  // ── 2. Managed worktree, activation, real committed writes ──────────────────
  const wikiRoot = join(root, 'wiki');
  gitRepo(wikiRoot);
  await sql(`INSERT INTO sources(id,name,local_path,incarnation) VALUES('managed-wiki','Managed wiki',$1,$2::uuid)`, [wikiRoot, LEGACY_IDS.wikiIncarnation]);
  await claimWorktree(engine, 'managed-wiki', wikiRoot);
  assert.equal((await activatePersistence(engine, { confirmQuiesced: true })).enabled, true);
  await sql(`INSERT INTO persistence_local_writers(id,lane,credential_hash,grant_ceiling,revoked_at,created_at)
    VALUES($1::uuid,'stdio',$2,$3::text::jsonb,'2026-03-02T00:00:00Z','2025-12-01T00:00:00Z')`,
  [LEGACY_IDS.revokedWriterId, sha256('legacy-fixture-revoked-writer'), JSON.stringify({ sourceIds: ['managed-wiki'], scopes: ['read', 'write'], operations: null, slugPrefixes: null })]);

  const world: World = { engine, config: { engine: engine.kind, embedding_disabled: true } as GBrainConfig, remotes: [], auth: new Map(), observations: new Map() };
  try {
    for (const [i, requestId] of LEGACY_IDS.managedRequestIds.entries()) {
      const d = descriptor(`managed-${i}`, 'put_page', 'local', 'managed-wiki',
        { slug: `notes/managed-${i}`, content: `---\ntype: note\ntitle: Managed ${i}\n---\n\nManaged write ${i}.\n` }, { requestId });
      const observed = await executeOp(world, d);
      assert.equal(observed.status, 'committed', `legacy fixture: managed write ${i} must commit (${observed.code ?? ''})`);
    }
  } finally {
    await disposePersistenceConsumer(engine);
  }

  // ── 3. Derived-work states ──────────────────────────────────────────────────
  const effectFor = async (requestId: string) => {
    const [row] = await engine.executeRaw<{ id: string }>(`SELECT e.id::text AS id FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
      WHERE r.request_id=$1::uuid AND e.kind='embedding'`, [requestId]);
    assert(row, `legacy fixture: request ${requestId} queued no embedding effect`);
    return row.id;
  };
  const [m0, m1, m2] = LEGACY_IDS.managedRequestIds;
  const effectIds = { failed: await effectFor(m0), delayed: await effectFor(m1), orphanRunning: await effectFor(m2) };
  await sql(`UPDATE persistence_effects SET state='failed',attempts=3,error_code='embedding_provider_failed',execution_token=NULL,claim_expires_at=NULL,
    outcome=NULL,next_attempt_at='2026-03-10T00:00:00Z' WHERE id=$1`, [effectIds.failed]);
  await sql(`UPDATE persistence_effects SET state='queued',attempts=1,error_code='embedding_rate_limited',execution_token=NULL,claim_expires_at=NULL,
    outcome=NULL,next_attempt_at='2099-01-01T00:00:00Z' WHERE id=$1`, [effectIds.delayed]);
  await sql(`UPDATE persistence_effects SET state='running',attempts=1,error_code=NULL,execution_token=$2::uuid,claim_expires_at='2026-03-10T00:05:00Z',
    outcome=NULL,next_attempt_at='2026-03-10T00:00:00Z' WHERE id=$1`, [effectIds.orphanRunning, LEGACY_IDS.orphanExecutionToken]);

  // The consumer re-chunked every page; the Acme chunk gets the legacy vector (vectors must round-trip as text).
  const embedded = await engine.executeRaw(`UPDATE content_chunks SET embedding=$2::vector,model='fixture:legacy',embedded_at='2025-11-02T00:00:00Z'
    WHERE page_id=$1 AND chunk_index=0 RETURNING id`, [acme, fixtureVector(chunkDims, 1)]);
  assert.equal(embedded.length, 1, 'legacy fixture: the Acme page has no chunk to embed');
  // Git effects settle on the consumer's timing; pin them to the state a crash right after publication leaves.
  await sql(`UPDATE persistence_effects SET state='queued',attempts=0,error_code=NULL,execution_token=NULL,claim_expires_at=NULL,
    next_attempt_at='2026-03-10T00:00:00Z' WHERE kind='git'`);
  // The in-process consumer projected every page; the three Alice pages go back to "projection queued".
  await sql(`UPDATE pages SET text_projection_revision=NULL WHERE source_id='default' AND slug IN ('people/alice-example','people/alice_example','people/älice-example')`);
  await sql(`INSERT INTO page_projection_jobs(source_incarnation,slug,revision,reason,updated_at)
    SELECT s.incarnation,p.slug,p.knowledge_revision,'canonical_change','2026-03-10T00:00:00Z' FROM pages p JOIN sources s ON s.id=p.source_id
    WHERE p.source_id='default' AND p.text_projection_revision IS NULL AND p.deleted_at IS NULL`);

  const queue = new MinionQueue(engine);
  const stale = await queue.add('noop', { fixture: 'stale-lease', payload: heavyJson(512 * 1024, 'minion') });
  await sql(`UPDATE minion_jobs SET status='active',claim_generation=claim_generation+1,lock_token='legacy-fixture-stale-lease',
    lock_until='2026-03-10T00:00:00Z',started_at='2026-03-09T23:59:00Z',attempts_started=1 WHERE id=$1`, [stale.id]);
  await sql(`UPDATE persistence_worktrees SET heartbeat_at='2026-03-10T00:00:00Z'`);
  // An orphan run lock: unexpired, its holder pid long gone (activation refuses while it stands, so it comes last).
  await sql(`INSERT INTO gbrain_cycle_locks(id,holder_pid,holder_host,acquired_at,ttl_expires_at) VALUES('gbrain-cycle',2147483646,'legacy-host','2026-01-01T00:00:00Z','2099-01-01T00:00:00Z')`);

  // ── 4. A queued request accepted with no owner running ──────────────────────
  const ctx = contextFor(world, 'local', 'managed-wiki');
  const binding = (await getWorktreeBinding(engine, 'managed-wiki'))!;
  const slug = 'notes/queued-request';
  const callerIntent = { source_id: 'managed-wiki', slug, content: '---\ntype: note\ntitle: Queued request\n---\n\nAccepted while no owner ran.\n' };
  const queued: WriteAdmission = { principal: await requestPrincipalForContext(ctx), operation: 'put_page', sourceId: 'managed-wiki',
    sourceIncarnation: LEGACY_IDS.wikiIncarnation, slug, pageId: null, requestId: LEGACY_IDS.queuedRequestId, callerIntent, intent: { ...callerIntent },
    authority: await submissionAuthority(ctx, 'put_page', 'managed-wiki', LEGACY_IDS.wikiIncarnation, slug),
    worktreeId: binding.worktree_id, topologyGeneration: binding.topology_generation };
  assert.equal((await admitWrite(engine, queued)).state, 'queued');
  writeFileSync(join(root, 'queued-admission.json'), JSON.stringify(queued, null, 2), { mode: 0o600 });

  return { root, hostId: localHostId(), wikiRoot, worktreeId: binding.worktree_id, queued, managedRequestIds: LEGACY_IDS.managedRequestIds,
    effectIds, staleJobId: Number(stale.id), embeddingDims: { content_chunks: chunkDims, facts: factDims } };
}

/** Read the recorded admission of the queued request (written by `buildLegacyBrain`). */
export function readQueuedAdmission(root: string): WriteAdmission {
  return JSON.parse(readFileSync(join(root, 'queued-admission.json'), 'utf8')) as WriteAdmission;
}

const iso = (value: unknown): string | null => value === null || value === undefined ? null : new Date(value as string).toISOString();

/** Rows of `table` as canonical JSON text, ordered by primary key under COLLATE "C", timestamps in UTC. Engine-independent. */
export async function canonicalRows(engine: BrainEngine, table: string): Promise<string[]> {
  const keys = await engine.executeRaw<{ col: string; text: boolean }>(`SELECT a.attname AS col, t.typcategory = 'S' AS text
    FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum = ANY(i.indkey) JOIN pg_type t ON t.oid=a.atttypid
    WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int2[], a.attnum)`, [table]);
  const order = keys.length ? keys.map(k => `t.${JSON.stringify(k.col)}${k.text ? ' COLLATE "C"' : ''}`).join(',') : 'to_jsonb(t)::text COLLATE "C"';
  return engine.transaction(async tx => {
    await tx.executeRaw("SELECT set_config('TimeZone','UTC',true), set_config('DateStyle','ISO',true), set_config('extra_float_digits','3',true)");
    const rows = await tx.executeRaw<{ r: string }>(`SELECT to_jsonb(t)::text AS r FROM ${JSON.stringify(table)} t ORDER BY ${order}`);
    return rows.map(row => row.r);
  });
}

async function count(engine: BrainEngine, table: string): Promise<number> {
  return Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${JSON.stringify(table)}`))[0].n);
}

function compare(mismatches: string[], label: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expected);
  if (a !== e) mismatches.push(`${label}: expected ${e}, got ${a}`);
}

async function effectState(engine: BrainEngine, requestId: string) {
  const [row] = await engine.executeRaw<Record<string, unknown>>(`SELECT e.state,e.attempts,e.error_code,e.execution_token::text AS execution_token,
    e.claim_expires_at,e.next_attempt_at FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
    WHERE r.request_id=$1::uuid AND e.kind='embedding'`, [requestId]);
  return row;
}

/** The withdrawal overlay: the stored body keeps the claim, the canonical snapshot strikes it. */
function overlayMismatches(m: string[], label: string, snapshot: { page: { compiled_truth: string } } | null, stored: string | undefined,
  want: LegacyExpected['source']['overlay']): void {
  for (const text of want.stored_contains) if (!stored?.includes(text)) m.push(`${label}: stored body lacks ${JSON.stringify(text)}`);
  for (const text of want.snapshot_contains) if (!snapshot?.page.compiled_truth.includes(text)) m.push(`${label}: snapshot lacks ${JSON.stringify(text)}`);
  for (const text of want.snapshot_excludes) if (snapshot?.page.compiled_truth.includes(text)) m.push(`${label}: snapshot still shows ${JSON.stringify(text)}`);
}

async function orderedKeys(engine: BrainEngine, sql: string): Promise<string[]> {
  return (await engine.executeRaw<{ k: string }>(sql)).map(r => r.k);
}

/** Every expectation in expected.json's `source` block that differs from this brain (empty when the fixture is exact). */
export async function legacySourceMismatches(engine: BrainEngine, expected = loadLegacyExpected()): Promise<string[]> {
  const m: string[] = [];
  const s = expected.source;
  for (const [table, n] of Object.entries(s.counts)) compare(m, `count ${table}`, await count(engine, table), n);
  const pages = await engine.executeRaw<{ slug: string; source_id: string; generation: number; deleted: boolean; attributed: boolean; queued: boolean }>(
    `SELECT p.slug,p.source_id,p.generation::int AS generation,p.deleted_at IS NOT NULL AS deleted,p.revision_principal_kind IS NOT NULL AS attributed,
      EXISTS(SELECT 1 FROM page_projection_jobs j JOIN sources src ON src.incarnation=j.source_incarnation WHERE src.id=p.source_id AND j.slug=p.slug) AS queued
     FROM pages p`);
  for (const [slug, want] of Object.entries(s.pages)) {
    const got = pages.find(p => p.slug === slug);
    if (!got) { m.push(`page ${slug}: missing`); continue; }
    compare(m, `page ${slug}`, { source_id: got.source_id, generation: want.generation === -1 ? -1 : Number(got.generation), deleted: got.deleted,
      attributed: got.attributed, projection_queued: got.queued }, want);
  }
  const facts = await engine.executeRaw<{ fact: string; expired_at: unknown; sup: string | null; attributed: boolean }>(
    `SELECT f.fact,f.expired_at,s.fact AS sup,f.write_principal_kind IS NOT NULL AS attributed FROM facts f LEFT JOIN facts s ON s.id=f.superseded_by`);
  for (const [text, want] of Object.entries(s.facts)) {
    const got = facts.find(f => f.fact === text);
    if (!got) { m.push(`fact ${text}: missing`); continue; }
    compare(m, `fact ${text}`, { expired_at: iso(got.expired_at), superseded_by_fact: got.sup, attributed: got.attributed }, want);
  }
  compare(m, 'takes', (await engine.executeRaw<{ row_num: number; active: boolean; superseded_by: number | null }>(
    'SELECT row_num,active,superseded_by FROM takes ORDER BY row_num')).map(t => ({ row_num: Number(t.row_num), active: t.active,
    superseded_by: t.superseded_by === null ? null : Number(t.superseded_by) })), s.takes);
  compare(m, 'withdrawal order', await orderedKeys(engine,
    `SELECT subject AS k FROM fact_withdrawals ORDER BY source_id COLLATE "C",visibility COLLATE "C",subject COLLATE "C",fact_hash COLLATE "C"`), s.withdrawal_subjects_c_order);
  compare(m, 'config order', await orderedKeys(engine, `SELECT key AS k FROM config WHERE key LIKE 'graduation_fixture.%' ORDER BY key COLLATE "C"`), s.config_keys_c_order);
  compare(m, 'projection order', await orderedKeys(engine, `SELECT slug AS k FROM page_projection_jobs ORDER BY source_incarnation, slug COLLATE "C"`), s.projection_slugs_c_order);
  compare(m, 'oauth client order', await orderedKeys(engine, `SELECT client_id AS k FROM oauth_clients ORDER BY client_id COLLATE "C"`), s.oauth_client_ids_c_order);
  overlayMismatches(m, 'overlay', await engine.readPageSnapshot(s.overlay.slug, { sourceId: 'default' }),
    (await engine.executeRaw<{ body: string }>(`SELECT compiled_truth AS body FROM pages WHERE source_id='default' AND slug=$1`, [s.overlay.slug]))[0]?.body, s.overlay);
  const [failed, delayed, orphan] = LEGACY_IDS.managedRequestIds;
  for (const [name, requestId] of [['failed', failed], ['delayed', delayed], ['orphan_running', orphan]] as const) {
    const got = await effectState(engine, requestId);
    const want = s.effects[name];
    compare(m, `effect ${name}`, { state: got?.state, attempts: Number(got?.attempts),
      ...('next_attempt_at' in want ? { next_attempt_at: iso(got?.next_attempt_at) } : {}),
      ...('error_code' in want ? { error_code: got?.error_code ?? null } : {}),
      execution_token: got?.execution_token ?? null, claim_expires_at: iso(got?.claim_expires_at) }, want);
  }
  const [job] = await engine.executeRaw<Record<string, unknown>>(`SELECT status,claim_generation,lock_token,lock_until FROM minion_jobs WHERE data->>'fixture'='stale-lease'`);
  compare(m, 'stale job', { status: job?.status, claim_generation: Number(job?.claim_generation), lock_token: job?.lock_token ?? null, lock_until: iso(job?.lock_until) }, s.stale_job);
  const [queued] = await engine.executeRaw<Record<string, unknown>>(`SELECT request_id::text AS request_id,state,slug,source_id FROM persistence_requests WHERE request_id=$1::uuid`,
    [s.queued_request.request_id]);
  compare(m, 'queued request', queued, s.queued_request);
  const managed = await engine.executeRaw<{ state: string }>(`SELECT state FROM persistence_requests WHERE request_id = ANY($1::uuid[])`, [LEGACY_IDS.managedRequestIds]);
  compare(m, 'managed requests', { state: [...new Set(managed.map(r => r.state))].join(','), count: managed.length }, s.managed_requests);
  for (const [name, want] of Object.entries(s.tokens)) {
    const [row] = await engine.executeRaw<{ revoked: boolean }>('SELECT revoked_at IS NOT NULL AS revoked FROM access_tokens WHERE name=$1', [name]);
    compare(m, `token ${name}`, row, want);
  }
  const [writers] = await engine.executeRaw<{ live: number; revoked: number }>(
    'SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS live, count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked FROM persistence_local_writers');
  compare(m, 'local writers', { live: Number(writers.live), revoked: Number(writers.revoked) }, s.local_writers);
  const [bytes] = await engine.executeRaw<Record<string, number>>(`SELECT
    (SELECT min(octet_length(data::text)) FROM raw_data)::int AS raw_data,
    (SELECT min(octet_length(metadata::text)) FROM files)::int AS files_metadata,
    (SELECT min(octet_length(data::text)) FROM minion_jobs)::int AS minion_data,
    (SELECT octet_length(frontmatter::text) FROM pages WHERE slug='companies/acme-example')::int AS frontmatter`);
  for (const key of ['raw_data', 'files_metadata', 'minion_data', 'frontmatter'] as const) {
    if (!(Number(bytes[key]) >= s.bytes[`${key}_min`])) m.push(`bytes ${key}: ${bytes[key]} < ${s.bytes[`${key}_min`]}`);
  }
  compare(m, 'cycle locks', await count(engine, 'gbrain_cycle_locks'), s.cycle_locks);
  const [vectors] = await engine.executeRaw<{ chunks: number; facts: number }>(`SELECT
    (SELECT count(*) FROM content_chunks WHERE embedding IS NOT NULL)::int AS chunks, (SELECT count(*) FROM facts WHERE embedding IS NOT NULL)::int AS facts`);
  compare(m, 'embeddings', { chunks: Number(vectors.chunks), facts: Number(vectors.facts) }, s.embeddings);
  const [brain] = await engine.executeRaw<{ enabled: boolean }>('SELECT enabled FROM persistence_brain WHERE singleton=1');
  compare(m, 'brain', brain, s.brain);
  return m;
}

export interface LegacySourceSnapshot {
  brainId: string;
  tables: Record<string, string[]>;
}

/** Capture what the target must reproduce, before graduation starts. */
export async function snapshotLegacySource(engine: BrainEngine, expected = loadLegacyExpected()): Promise<LegacySourceSnapshot> {
  const [brain] = await engine.executeRaw<{ brain_id: string }>('SELECT brain_id::text AS brain_id FROM persistence_brain WHERE singleton=1');
  const tables: Record<string, string[]> = {};
  for (const table of expected.target.unchanged_tables) tables[table] = await canonicalRows(engine, table);
  return { brainId: brain.brain_id, tables };
}

/**
 * Every expectation in expected.json's `target` block that differs on the
 * graduated target. `verifyToken` is the production verifier bound to the
 * target (`new GBrainOAuthProvider({ sql }).verifyAccessToken`).
 */
export async function legacyTargetMismatches(target: BrainEngine, before: LegacySourceSnapshot,
  verifyToken: (token: string) => Promise<unknown>, expected = loadLegacyExpected()): Promise<string[]> {
  const m: string[] = [];
  const t = expected.target;
  for (const [table, n] of Object.entries(t.counts)) compare(m, `target count ${table}`, await count(target, table), n);
  for (const table of t.absent_tables) compare(m, `target ${table} discarded`, await count(target, table), 0);
  for (const table of t.unchanged_tables) {
    const rows = await canonicalRows(target, table);
    const want = before.tables[table];
    if (rows.length !== want.length) { m.push(`target ${table}: ${rows.length} rows, source had ${want.length}`); continue; }
    const first = rows.findIndex((row, i) => row !== want[i]);
    if (first >= 0) m.push(`target ${table}: row ${first} differs\n  source ${want[first].slice(0, 400)}\n  target ${rows[first].slice(0, 400)}`);
  }
  const [failed, delayed, orphan] = LEGACY_IDS.managedRequestIds;
  for (const [name, requestId] of [['failed', failed], ['delayed', delayed], ['orphan_running', orphan]] as const) {
    const got = await effectState(target, requestId);
    const want = t.effects[name];
    compare(m, `target effect ${name}`, { state: got?.state, attempts: Number(got?.attempts),
      ...('next_attempt_at' in want ? { next_attempt_at: iso(got?.next_attempt_at) } : {}),
      execution_token: got?.execution_token ?? null, claim_expires_at: iso(got?.claim_expires_at) }, want);
  }
  const [job] = await target.executeRaw<Record<string, unknown>>(`SELECT status,claim_generation,lock_token,lock_until FROM minion_jobs WHERE data->>'fixture'='stale-lease'`);
  compare(m, 'target stale job', { status: job?.status, claim_generation: Number(job?.claim_generation), lock_token: job?.lock_token ?? null, lock_until: iso(job?.lock_until) }, t.stale_job);
  const heartbeats = await target.executeRaw<{ h: unknown }>('SELECT heartbeat_at AS h FROM persistence_worktrees');
  compare(m, 'target worktree heartbeat', heartbeats.map(r => iso(r.h)), heartbeats.map(() => t.worktree_heartbeat_at));
  const [queued] = await target.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE request_id=$1::uuid', [expected.source.queued_request.request_id]);
  compare(m, 'target queued request', queued?.state, t.queued_request.state);
  for (const [name, want] of Object.entries(t.tokens_authorize)) {
    const secret = expected.secrets[name as keyof typeof expected.secrets];
    const ok = await verifyToken(secret).then(() => true, () => false);
    compare(m, `target token ${name} authorizes`, ok, want);
  }
  const [brain] = await target.executeRaw<{ enabled: boolean; brain_id: string }>('SELECT enabled,brain_id::text AS brain_id FROM persistence_brain WHERE singleton=1');
  compare(m, 'target brain', { enabled: brain?.enabled, brain_id_equals_source: brain?.brain_id === before.brainId }, t.brain);
  const s = expected.source;
  compare(m, 'target withdrawal order', await orderedKeys(target,
    `SELECT subject AS k FROM fact_withdrawals ORDER BY source_id COLLATE "C",visibility COLLATE "C",subject COLLATE "C",fact_hash COLLATE "C"`), s.withdrawal_subjects_c_order);
  compare(m, 'target config order', await orderedKeys(target, `SELECT key AS k FROM config WHERE key LIKE 'graduation_fixture.%' ORDER BY key COLLATE "C"`), s.config_keys_c_order);
  compare(m, 'target oauth client order', await orderedKeys(target, `SELECT client_id AS k FROM oauth_clients ORDER BY client_id COLLATE "C"`), s.oauth_client_ids_c_order);
  const projected = await orderedKeys(target, `SELECT slug AS k FROM page_projection_jobs ORDER BY slug COLLATE "C"`);
  for (const slug of s.projection_slugs_c_order) if (!projected.includes(slug)) m.push(`target projection job ${slug}: missing`);
  overlayMismatches(m, 'target overlay', await target.readPageSnapshot(s.overlay.slug, { sourceId: 'default' }),
    (await target.executeRaw<{ body: string }>(`SELECT compiled_truth AS body FROM pages WHERE source_id='default' AND slug=$1`, [s.overlay.slug]))[0]?.body, s.overlay);
  return m;
}
