/** A discriminated union that models an operation that can fail without throwing. */
export type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok(): Result<void, never>;
export function ok<T>(value: T): Result<T, never>;
export function ok<T>(value?: T): Result<T | undefined, never> {
  return { ok: true, value };
}

export const err = <E>(error: E): Result<never, E> => ({ error, ok: false });
