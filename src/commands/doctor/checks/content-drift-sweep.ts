/**
 * content_drift_sweep doctor check (#7117): the content-drift sweep's saved
 * pass record (core/content-drift-sweep.ts), one config row per embedding
 * column and scope. Warns while the latest batch failed (the row's
 * last_error, cleared by the next batch that commits), naming the error and
 * where the pass stands; otherwise reports each scope's last completed pass
 * and its cursor. Reads config only.
 */
import type { Check } from '../../doctor.ts';
import { agentFix, checkError } from '../check-fix.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { CONTENT_DRIFT_SWEEP_KEY_PREFIX, readContentDriftSweepStates } from '../../../core/content-drift-sweep.ts';

const DOCS = 'docs/guides/troubleshooting.md#content-drift-sweep';

async function runContentDriftSweepCheck(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    const scopes = (await readContentDriftSweepStates(connectedEngine(ctx))).map(({ key, state }) => ({
      scope: key.slice(CONTENT_DRIFT_SWEEP_KEY_PREFIX.length), cursor: state.cursor, pass_started_at: state.pass_started_at,
      last_completed_at: state.last_completed_at, last_pass_checked: state.last_pass_checked, last_pass_drifted: state.last_pass_drifted,
      last_error: state.last_error,
    }));
    const failing = scopes.filter(s => s.last_error);
    const details = { code: 'content_drift_sweep', scopes, docs: DOCS };
    if (failing.length > 0) {
      checks.push({
        name: 'content_drift_sweep', status: 'warn', details,
        message: `The content-drift sweep's latest batch failed: ${failing.map(s => `${s.scope} at chunk id ${s.cursor} (${s.last_error!.at}): ${s.last_error!.message}`).join('; ')}. `
          + 'Vectors whose chunk text changed stay in place until a pass reaches them; the next embed run retries from the saved cursor. '
          + `Nothing was changed by this check. See ${DOCS}.`,
        fix: agentFix(['gbrain', 'embed', '--stale'], 'Retries the sweep from its saved cursor and re-embeds what it invalidates; embedding spends tokens, so ask the user first.',
          'content_drift_sweep', { consent: ['paid'], docs: DOCS }),
      });
      return checks;
    }
    checks.push({
      name: 'content_drift_sweep', status: 'ok', details,
      message: scopes.length === 0
        ? 'The content-drift sweep has not run yet; it runs inside embed --stale and the embed jobs.'
        : scopes.map(s => `${s.scope}: ${s.last_completed_at ? `last pass completed ${s.last_completed_at} (${s.last_pass_checked} checked, ${s.last_pass_drifted} invalidated)` : 'no pass completed yet'}`
          + `${s.cursor > 0 ? `, current pass at chunk id ${s.cursor}` : ''}`).join('; '),
    });
  } catch (error) {
    checks.push(checkError('content_drift_sweep', 'read the content-drift sweep state', error, { details: { health: 'unknown' } }));
  }
  return checks;
}

export const contentDriftSweepEntry: DoctorEntry = {
  name: 'content_drift_sweep',
  emits: ['content_drift_sweep'],
  run: runContentDriftSweepCheck,
};
