import { describe, expect, it } from 'vitest';

import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { EMAIL_ERROR, normaliseEmail } from './email.ts';

describe('normaliseEmail', () => {
  it('ID-3 trims and lower-cases an address', () => {
    expect(unwrapOk(normaliseEmail('  Ada.Lovelace@Example.COM '))).toBe(
      'ada.lovelace@example.com',
    );
    const longest = `${'a'.repeat(242)}@example.com`;
    expect(unwrapOk(normaliseEmail(longest))).toHaveLength(254);
  });

  it('ID-3 refuses an address that is not shaped like one', () => {
    const rejected = [
      '',
      'ada',
      '@example.com',
      'ada@',
      'ada@example',
      'ada@.com',
      'ada@example.',
      'ada@@example.com',
      'ada@example.com@example.com',
      'ada lovelace@example.com',
      ['ada@exam', 'ple.com'].join('\t'),
      `${'a'.repeat(243)}@example.com`,
    ];
    for (const address of rejected) {
      expect(unwrapFail(normaliseEmail(address)).message).toBe(EMAIL_ERROR);
    }
  });
});
