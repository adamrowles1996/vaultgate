import { describe, expect, it } from 'vitest';

import { fail, ok } from './result.ts';
import { unwrapFail, unwrapOk } from './test-support/result.ts';

describe('Result', () => {
  it('wraps a success value', () => {
    expect(ok(42)).toStrictEqual({ ok: true, value: 42 });
    expect(unwrapOk(ok(42))).toBe(42);
  });

  it('wraps a failure and preserves the error instance', () => {
    const error = new Error('nope');
    expect(fail(error)).toStrictEqual({ ok: false, error });
    expect(unwrapFail(fail(error))).toBe(error);
  });

  it('unwrap helpers throw when the variant is unexpected', () => {
    expect(() => unwrapOk(fail(new Error('boom')))).toThrow(
      'expected a success but got failure: boom',
    );
    expect(() => unwrapFail(ok(1))).toThrow('expected a failure but got a success');
  });
});
