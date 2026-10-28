declare function opError(...args: unknown[]): Error;
export function f() { throw opError('invalid_params', 'Bad input.', 'Run `gbrain repair --help`.'); }
