/**
 * #7177: the opt-in "nothing matched" exit (NO_RESULTS_EXIT_CODE) for lookup
 * commands. With GBRAIN_FAIL_ON_EMPTY=1 a miss exits 12 with one stderr line;
 * without it the exit stays 0 (a non-zero exit under --json is a failure
 * document in the agent operator contract), and --json still says
 * `status: "no_results"` (recall) or `found: false` (entity).
 */
import { NO_RESULTS_EXIT_CODE } from '../core/exit-codes.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

export function markNoResults(command: string): void {
  if (process.env.GBRAIN_FAIL_ON_EMPTY !== '1') return;
  process.stderr.write(`[${command}] exit ${NO_RESULTS_EXIT_CODE} (no_results): nothing matched (GBRAIN_FAIL_ON_EMPTY=1).\n`);
  setCliExitVerdict(NO_RESULTS_EXIT_CODE);
}
