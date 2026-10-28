declare class OperationError extends Error { constructor(...args: unknown[]); }
export function fail(code: string, message: string, nextHint?: string): never {
  throw new OperationError(code, message, nextHint ?? 'Pass a slug.');
}
