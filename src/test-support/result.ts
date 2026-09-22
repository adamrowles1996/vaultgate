import type { Result } from '../result.ts';

/**
Narrows a Result to its value, failing the test loudly if it is a failure.
*/
export function unwrapOk<T, E extends Error>(result: Result<T, E>): T {
  if (!result.ok) {
    throw new Error(`expected a success but got failure: ${result.error.message}`);
  }
  return result.value;
}

/**
Narrows a Result to its error, failing the test loudly if it is a success.
*/
export function unwrapFail<T, E extends Error>(result: Result<T, E>): E {
  if (result.ok) {
    throw new Error('expected a failure but got a success');
  }
  return result.error;
}
