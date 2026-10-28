/**
 * #7145: a check that stopped at one of its own bounds (a file-walk limit, a
 * row cap, a scan timeout) did not see everything, so its health is unknown:
 * never clear, and never a known problem. Same shape as the runner's budget
 * unknowns in ./budget.ts (`status: 'warn'`, `details.health: 'unknown'`,
 * `details.exact: false`), with `reason: 'bound'` and `bound` naming which
 * bound stopped it; each check keeps its own limit fields beside it.
 */
export function boundUnknownDetails(bound: string): { health: 'unknown'; reason: 'bound'; bound: string; exact: false } {
  return { health: 'unknown', reason: 'bound', bound, exact: false };
}
