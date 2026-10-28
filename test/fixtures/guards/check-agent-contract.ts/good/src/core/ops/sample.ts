declare function opError(...args: unknown[]): Error;
export function f() { throw opError('invalid_params', 'Bad input.', 'Pass a slug.', { fix: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', why: 'w', requires_exclusive: false, verify: { argv: ['gbrain', 'doctor', '--json'] } } }); }
export const inputFix = { argv: ['gbrain', 'pricing', 'set', '<model>'], inputs: [{ name: 'model', how: 'h' }], consent: [], actor: 'agent', why: 'w', requires_exclusive: false };
export const op = { name: 'put_x', mutating: true, idempotent: true, handler: async () => { throw opError('invalid_params', 'Failed.', 'Retry with the same request_id; run `gbrain sync --no-pull` first.'); } };
export const cliOnlyOp = { name: 'inspect_x', cliOnly: { argv: ['gbrain', 'sources', 'inspect', '<path>'] }, handler: async () => null };
const invalid = (message: string, suggestion: string) => opError('invalid_params', message, suggestion);
export function g() { throw invalid('--limit must be a positive integer.', 'Pass --limit as a positive integer, e.g. gbrain repair --limit 50; see gbrain repair --help for the other flags.'); }
