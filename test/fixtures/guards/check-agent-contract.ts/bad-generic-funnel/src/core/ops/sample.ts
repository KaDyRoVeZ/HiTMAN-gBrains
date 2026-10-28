declare function opError(...args: unknown[]): Error;
const invalid = (message: string, suggestion: string) => opError('invalid_params', message, suggestion);
export function f() { throw invalid('Bad input.', 'Check your input.'); }
