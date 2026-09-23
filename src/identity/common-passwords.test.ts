import { describe, expect, it } from 'vitest';

import { isCommonPassword } from './common-passwords.ts';

describe('isCommonPassword', () => {
  it('ID-5 rejects well-known entries regardless of case', () => {
    expect(isCommonPassword('password')).toBe(true);
    expect(isCommonPassword('PASSWORD')).toBe(true);
    expect(isCommonPassword('123456')).toBe(true);
  });

  it('ID-5 accepts text that is not on the list', () => {
    expect(isCommonPassword('correct horse battery staple 2026')).toBe(false);
  });
});
