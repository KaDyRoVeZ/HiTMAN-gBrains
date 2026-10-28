/**
 * facts_drain (Lane D): the automatic facts drain on PGLite (src/core/facts/drain.ts).
 * Reports on/off, the queued facts-absorb backlog, the last run and its spend, and a
 * deferral (no key, budget used up, unpriced model under a user cap) with its fix,
 * so a background failure reaches the agent. Reads the database only.
 */
import { FACTS_DRAIN_DOCS, readFactsDrainStatus } from '../../../core/facts/drain.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

async function runFactsDrainCheck(ctx: DoctorContext): Promise<Check[]> {
  const status = await readFactsDrainStatus(connectedEngine(ctx));
  const details = {
    health: status.health, backlog: status.backlog, last_run: status.last_run, daily_spent_usd: status.daily_spent_usd,
    ...(status.settings ? { enabled: status.settings.enabled, budget_usd: status.settings.budgetUsd, daily_budget_usd: status.settings.dailyBudgetUsd, max_jobs: status.settings.maxJobs } : {}),
    docs: FACTS_DRAIN_DOCS,
  };
  const fix = status.fix ? { fix: status.fix } : {};
  const checks: Check[] = [];
  if (status.health === 'not_applicable' || status.health === 'disabled') {
    checks.push({ name: 'facts_drain', status: 'ok', message: status.message, severity: 'info',
      readiness_state: status.health === 'disabled' ? 'disabled_by_choice' : 'not_applicable', ...fix, details });
  } else if (status.health === 'deferred' || status.health === 'no_owner') {
    checks.push({ name: 'facts_drain', status: 'warn', message: status.message, readiness_state: 'degraded', ...fix, details });
  } else {
    checks.push({ name: 'facts_drain', status: 'ok', message: status.message, details });
  }
  return checks;
}

export const factsDrainEntry: DoctorEntry = { name: 'facts_drain', emits: ['facts_drain'], run: runFactsDrainCheck };
