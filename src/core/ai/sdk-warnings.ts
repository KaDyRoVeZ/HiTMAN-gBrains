/**
 * AI SDK provider warnings go to stderr (#5892). The `ai` package logs a
 * model's warnings (a claude-cli v2-compat notice, an Anthropic "unsupported
 * setting") through `globalThis.AI_SDK_LOG_WARNINGS`; left unset, its first
 * warning prints a banner with `console.info`, which lands on stdout and
 * corrupts `--json` output. The gateway calls `installAiSdkWarningWriter()`
 * when it loads (so CLI, worker, serve and library callers are all covered):
 * a writer that prints the same per-warning lines to stderr and no banner. A
 * value the user already set (`false` to silence, or their own function) is
 * kept.
 */
import type { LogWarningsFunction, Warning } from 'ai';

/** One warning line in the `ai` package's own wording. */
export function formatAiSdkWarning(warning: Warning, provider: string, model: string): string {
  const prefix = `AI SDK Warning (${provider} / ${model}):`;
  switch (warning.type) {
    case 'unsupported':
      return `${prefix} The feature "${warning.feature}" is not supported.${warning.details ? ` ${warning.details}` : ''}`;
    case 'compatibility':
      return `${prefix} The feature "${warning.feature}" is used in a compatibility mode.${warning.details ? ` ${warning.details}` : ''}`;
    case 'other':
      return `${prefix} ${warning.message}`;
    default:
      return `${prefix} ${JSON.stringify(warning)}`;
  }
}

export const writeAiSdkWarningsToStderr: LogWarningsFunction = ({ warnings, provider, model }) => {
  for (const warning of warnings) process.stderr.write(`${formatAiSdkWarning(warning, provider, model)}\n`);
};

/** Install the stderr writer unless the global is already set. */
export function installAiSdkWarningWriter(): void {
  if (globalThis.AI_SDK_LOG_WARNINGS === undefined) globalThis.AI_SDK_LOG_WARNINGS = writeAiSdkWarningsToStderr;
}
