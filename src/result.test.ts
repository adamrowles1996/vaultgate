import { describe, expect, it } from 'vitest';

import { err, ok } from './result.ts';

describe('Result', () => {
  it('wraps a success value', () => {
    const result = ok(42);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('wraps a failure and preserves the error instance', () => {
    const error = new Error('nope');
    const result = err(error);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(error);
    }
  });
});
