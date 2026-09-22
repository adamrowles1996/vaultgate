import type { RandomSource } from '../identity/primitives.ts';

/**
A deterministic random source: every byte is `fill`, so fixtures are derivable, not pasted.
*/
export function fixedRandom(fill = 1): RandomSource {
  return (bytes) => Buffer.alloc(bytes, fill);
}

/**
A counting random source: each call yields distinct, still deterministic bytes.
*/
export function sequentialRandom(): RandomSource {
  let calls = 0;
  return (bytes) => {
    calls += 1;
    return Buffer.alloc(bytes, calls);
  };
}
