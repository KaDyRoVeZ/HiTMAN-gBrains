/**
 * managed_sync_latency (#6858 ask 6, GBRA-133 PR 2b.5): how long commits take to reach search, per source, over the
 * last 24 h, and the commit that is still waiting.
 *
 * Two clocks, graded the same way:
 *   - samples: the p95 commit→searchable latency of each managed source's synced commits (reader:
 *     persistence/sync-freshness.ts, which also reports commit→embedded);
 *   - the oldest unsynced commit of every source, managed or classic (core/sync-pending.ts): HEAD differs from the
 *     synced commit, aged from the reflog entry that moved HEAD (or the commit notifier's persisted first_due_at), or
 *     unknown when neither can date it (no reflog, rewritten history). A stalled source has no new samples, so this
 *     is what keeps it from reading ok.
 * Keyword-visible and embedded freshness are reported separately for every synced source that is not current on both
 * clocks (details.freshness_by_source, absent when every source is current, so a caught-up brain's output is
 * unchanged); the embedding backlog is reported, not graded (a keyless brain reads disabled).
 * It grades only a brain that asked for low latency, with `sync.on_commit` true or `sync.freshness_target_seconds` set: a
 * p95 or a waiting commit over the target (default 300 s) warns and one over max(1 h, target) fails; a waiting commit of
 * unknown age and synced commits it cannot date (not in this host's checkout) warn. Otherwise it reports ok with the
 * numbers, so a cron-synced brain sees no new warning. `doctor --source` (and a remote caller's sources) scope it like
 * every source-aware check (doctorSourceIds); a remote caller's run reads no git (the notifier's first_due_at only). A
 * stopped run belongs to managed_sync_blocked (#6861) and a run that stopped moving to managed_sync_not_moving. Reads the
 * database, one read-only `git log` per sampled source, and per source one `rev-parse HEAD` and its reflog file.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, doctorSourceIds, type DoctorContext, type DoctorEntry } from '../context.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { readManagedMode } from '../../../core/persistence/managed-mode.ts';
import { FRESHNESS_FAIL_SECONDS, formatLatency, readFreshnessTarget, readSyncFreshness, type SourceFreshness } from '../../../core/persistence/sync-freshness.ts';
import { loadPendingRoster, readEmbedBacklog, readPendingCommits, type EmbedBacklog, type PendingCommit } from '../../../core/sync-pending.ts';
import { parseOnCommit } from '../../../core/commit-notifier.ts';
import { SYNC_ON_COMMIT_KEY } from '../../../core/sync-config-keys.ts';

const DOCS = 'docs/guides/on-commit-sync.md';
const p95 = (f: SourceFreshness) => f.commit_to_searchable.p95_seconds ?? 0;
const line = (f: SourceFreshness) => `${f.source_id} (p95 ${formatLatency(f.commit_to_searchable.p95_seconds)}, p50 ${formatLatency(f.commit_to_searchable.p50_seconds)}, ${f.commit_to_searchable.samples} page(s))`;
const waiting = (p: PendingCommit) => p.state === 'behind'
  ? `${p.source_id} (waiting ${formatLatency(p.age_seconds)} since ${p.since}, dated from the ${p.evidence === 'reflog' ? 'reflog' : 'notifier first_due_at'})`
  : `${p.source_id} (age unknown: ${p.reason === 'history_rewritten' ? 'the synced commit is not an ancestor of HEAD' : 'no reflog entry reaches the synced commit'})`;

function embeddedState(pending: PendingCommit, backlog: EmbedBacklog | undefined): string {
  if (backlog?.state === 'disabled') return 'disabled';
  if (pending.state === 'behind' || backlog?.state === 'behind') return 'behind';
  if (pending.state === 'unknown' || backlog?.state === 'unknown') return 'unknown';
  return pending.state === 'current' ? 'current' : pending.state;
}

async function runManagedSyncLatencyCheck(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const engine = connectedEngine(ctx);
    const scope = doctorSourceIds(ctx);
    const managed = await readManagedMode(engine);
    const roster = (await loadPendingRoster(engine, scope)).map(s => ({ ...s, managed: managed && s.managed }));
    const pending = await readPendingCommits(engine, roster, { git: ctx.sourceIds === undefined });
    if (!managed && !pending.some(p => p.state === 'behind' || p.state === 'unknown')) {
      checks.push({ name: 'managed_sync_latency', status: 'ok', message: 'Not a managed brain; commit→searchable latency is measured for managed sources only, and no classic source has a commit known to be waiting.' });
      return checks;
    }
    const onCommit = parseOnCommit(await engine.getConfig(SYNC_ON_COMMIT_KEY));
    const target = await readFreshnessTarget(engine);
    const failSeconds = Math.max(FRESHNESS_FAIL_SECONDS, target.seconds);
    const graded = onCommit || target.explicit;
    const freshness = managed ? await readSyncFreshness(engine, { sourceIds: scope }) : [];
    const backlog = await readEmbedBacklog(engine, roster.map(s => s.id));
    const samplesBy = new Map(freshness.map(f => [f.source_id, f]));
    const freshnessBySource = roster.flatMap((s, i) => {
      const keyword = pending[i]!.state, embedded = embeddedState(pending[i]!, backlog.get(s.id));
      if (keyword === 'never_synced' || (keyword === 'current' && (embedded === 'current' || embedded === 'disabled'))) return [];
      return [{ source_id: s.id, kind: s.managed ? 'managed' : 'classic',
        keyword_visible: { state: keyword, oldest_unsynced: pending[i]!, samples: samplesBy.get(s.id)?.commit_to_searchable ?? null },
        embedded: { state: embedded, backlog: backlog.get(s.id) ?? null, samples: samplesBy.get(s.id)?.commit_to_embedded ?? null } }];
    });
    const sampled = freshness.filter(f => f.commit_to_searchable.samples > 0);
    const details = { graded, on_commit: onCommit, target_seconds: target.seconds, fail_seconds: failSeconds, sources: freshness, ...(freshnessBySource.length ? { freshness_by_source: freshnessBySource } : {}), docs: DOCS };
    const behind = pending.filter(p => p.state === 'behind');
    const undatable = pending.filter(p => p.state === 'unknown');
    const waitFail = behind.filter(p => (p.age_seconds ?? 0) > failSeconds);
    const waitSlow = behind.filter(p => (p.age_seconds ?? 0) > target.seconds);
    const waitLine = [...behind, ...undatable].map(waiting).join('; ');
    const waitPrefix = waitLine ? `Unsynced commit(s): ${waitLine}. ` : '';
    const failing = sampled.filter(f => p95(f) > failSeconds);
    const slow = sampled.filter(f => p95(f) > target.seconds);
    const firstId = failing[0]?.source_id ?? waitFail[0]?.source_id ?? slow[0]?.source_id ?? waitSlow[0]?.source_id ?? undatable[0]?.source_id;
    const fix = firstId ? agentFix(['gbrain', 'sync', 'status', '--source', firstId, '--json'],
      `Read-only: shows whether ${firstId}'s sync is behind, held or stopped, who syncs it, and the next step it names.`, 'managed_sync_latency', { docs: DOCS }) : undefined;
    const undated = freshness.filter(f => f.unresolved_commits > 0);
    const undatedCount = undated.reduce((n, f) => n + f.unresolved_commits, 0);
    const undatedLine = undated.map(f => `${f.source_id} (${f.unresolved_commits})`).join(', ');
    const window = freshness[0]?.window_hours ?? 24;
    if (graded && (failing.length || waitFail.length)) {
      checks.push({ name: 'managed_sync_latency', status: 'fail', readiness_state: 'degraded', details, fix,
        message: `${waitFail.length ? `${waitFail.map(waiting).join('; ')}: a commit has waited over ${formatLatency(failSeconds)} to reach search. ` : ''}`
          + (failing.length ? `${failing.map(line).join('; ')}: p95 commit→searchable is over ${formatLatency(failSeconds)}. New commits take that long to reach search.` : '') });
    } else if (graded && (slow.length || waitSlow.length || undatable.length)) {
      const parts = [
        waitSlow.length ? `${waitSlow.map(waiting).join('; ')}: a commit has waited over the ${formatLatency(target.seconds)} target to reach search.` : '',
        undatable.length ? `${undatable.map(waiting).join('; ')}: a commit has not reached search and its wait cannot be dated.` : '',
        slow.length ? `${slow.map(line).join('; ')}: p95 commit→searchable is over the ${formatLatency(target.seconds)} target (sync.freshness_target_seconds).` : '',
      ].filter(Boolean);
      checks.push({ name: 'managed_sync_latency', status: 'warn', readiness_state: 'degraded', details, fix, message: parts.join(' ') });
    } else if (!sampled.length && graded && undatedCount) {
      checks.push({ name: 'managed_sync_latency', status: 'warn', details,
        fix: agentFix(['gbrain', 'sync', 'status', '--source', undated[0]!.source_id, '--json'],
          `Read-only: shows ${undated[0]!.source_id}'s managed sync state and checkout; the latency needs the synced commits in this host's checkout.`, 'managed_sync_latency', { docs: DOCS }),
        message: `${waitPrefix}Commit→searchable latency could not be measured for ${undatedCount} commit(s) synced in the last ${window} h: ${undatedLine}. The commit is not in this host's local git checkout, so its commit time is unknown.` });
    } else if (!sampled.length) {
      checks.push({ name: 'managed_sync_latency', status: 'ok', details,
        message: waitPrefix + (undatedCount
          ? `No commit→searchable samples in the last ${window} h: ${undatedCount} synced commit(s) are not in this host's local git checkout (${undatedLine}); not graded (sync.on_commit is off and no target is set).`
          : `No commit→searchable samples in the last ${window} h (no managed sync imported a new commit).${waitPrefix && !graded ? ' Not graded (sync.on_commit is off and no target is set).' : ''}`) });
    } else {
      checks.push({ name: 'managed_sync_latency', status: 'ok', severity: 'info', details,
        message: `${waitPrefix}Commit→searchable over the last 24 h: ${sampled.map(line).join('; ')}${graded ? `, within the ${formatLatency(target.seconds)} target` : '; not graded (sync.on_commit is off and no target is set)'}.` });
    }
  } catch (error) {
    checks.push(checkError('managed_sync_latency', 'read managed sync freshness', error, { details: { health: 'unknown', docs: DOCS } }));
  }
  return checks;
}

export const managedSyncLatencyEntry: DoctorEntry = { name: 'managed_sync_latency', emits: ['managed_sync_latency'], run: runManagedSyncLatencyCheck };
