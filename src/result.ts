/**
 * Minimal Result type. Application code returns `Result` for expected
 * failures (bad configuration, a rejected credential, a vault that is locked)
 * and reserves thrown exceptions for programmer errors.
 */
export type Result<T, E extends Error = Error> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E extends Error>(error: E): Result<never, E> {
  return { ok: false, error };
}
