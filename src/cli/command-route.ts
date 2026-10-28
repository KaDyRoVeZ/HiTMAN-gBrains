/**
 * #7191: `search --exact "<phrase>"` is the exhaustive literal scan
 * (`search-exact`), routed before any ranked-search flag is parsed; a `--exact`
 * after a bare `--` is a positional and routes nothing. Shared by the CLI
 * dispatcher (cli/main.ts) and the docs command checker so both read the same
 * command. The `ask` alias stays inline in main.ts, where the dispatch-shape
 * analyzer reads it.
 */
export function routeCommand(command: string, subArgs: string[]): { command: string; subArgs: string[] } {
  if (command !== 'search') return { command, subArgs };
  const at = subArgs.indexOf('--exact');
  const end = subArgs.indexOf('--');
  if (at < 0 || (end >= 0 && end < at)) return { command, subArgs };
  return { command: 'search-exact', subArgs: subArgs.filter((_, i) => i !== at) };
}
