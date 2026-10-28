declare function opError(...args: unknown[]): Error;
const invalid = (message: string, suggestion = 'Correct that parameter.') => opError('invalid_params', message, suggestion);
export function f() { throw invalid('Bad input.'); }
