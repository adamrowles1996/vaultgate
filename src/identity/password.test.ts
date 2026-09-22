// cspell:ignore qweasdzxc
import { describe, expect, it } from 'vitest';

import { fixedRandom } from '../test-support/identity.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import {
  checkPasswordPolicy,
  CURRENT_PARAMETERS,
  hashPassword,
  isCorrectPassword,
  parseStoredHash,
  requiresRehash,
} from './password.ts';

const FAST = { cost: 2 ** 4, blockSize: 8, parallelism: 1 };
const PASSPHRASE = 'a perfectly serviceable passphrase';
// RFC 7914 §12, second vector: ("password", "NaCl", N=1024, r=8, p=16, dkLen=64).
const RFC_7914_DIGEST_HEX = [
  'fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162',
  '2eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640',
].join('');

describe('checkPasswordPolicy', () => {
  it('ID-5 accepts any password of 12 to 256 characters', () => {
    const longest = 'x'.repeat(256);
    expect(unwrapOk(checkPasswordPolicy('twelve chars'))).toBe('twelve chars');
    expect(unwrapOk(checkPasswordPolicy(longest))).toBe(longest);
  });

  it('ID-5 rejects fewer than 12 characters', () => {
    const error = unwrapFail(checkPasswordPolicy('not enough'));
    expect(error.message).toBe('use at least 12 characters');
  });

  it('ID-5 rejects more than 256 characters', () => {
    const error = unwrapFail(checkPasswordPolicy('x'.repeat(257)));
    expect(error.message).toBe('use at most 256 characters');
  });

  it('ID-5 rejects a common password even when long enough', () => {
    const error = unwrapFail(checkPasswordPolicy('123qweasdzxc'));
    expect(error.name).toBe('PasswordPolicyError');
    expect(error.message).toBe('that password is on the list of most common passwords');
  });
});

describe('hashPassword', () => {
  it('ID-6 stores scrypt$N$r$p$salt$hash with the current parameters', async () => {
    const stored = await hashPassword(PASSPHRASE, fixedRandom(7));
    const parsed = parseStoredHash(stored);
    expect(stored.startsWith('scrypt$131072$8$1$')).toBe(true);
    expect(parsed?.parameters).toStrictEqual(CURRENT_PARAMETERS);
    expect(parsed?.salt).toStrictEqual(Buffer.alloc(32, 7));
    expect(parsed?.hash.length).toBe(64);
  });

  it('ID-6 is a known-answer for the RFC 7914 scrypt vector encoding', async () => {
    const stored = await hashPassword('password', () => Buffer.from('NaCl'), {
      cost: 1024,
      blockSize: 8,
      parallelism: 16,
    });
    const parsed = parseStoredHash(stored);
    expect(stored.startsWith('scrypt$1024$8$16$TmFDbA==$')).toBe(true);
    expect(parsed?.hash.toString('hex')).toBe(RFC_7914_DIGEST_HEX);
  });
});

describe('isCorrectPassword', () => {
  it('ID-7 accepts the matching password and rejects any other', async () => {
    const stored = await hashPassword(PASSPHRASE, fixedRandom(), FAST);
    const isMatching = await isCorrectPassword(PASSPHRASE, stored);
    const isOther = await isCorrectPassword(`${PASSPHRASE}!`, stored);
    expect(isMatching).toBe(true);
    expect(isOther).toBe(false);
  });

  it('ID-7 treats a malformed stored hash as a mismatch', async () => {
    const malformed = [
      'bcrypt$nope',
      'scrypt$0$8$1$AA==$AA==',
      'scrypt$16$x$1$AA==$AA==',
      'scrypt$16$8$$AA==$AA==',
      'scrypt$16$8$1$AA==$AA==',
    ];
    const outcomes = await Promise.all(
      malformed.map((stored) => isCorrectPassword(PASSPHRASE, stored)),
    );
    expect(outcomes).toStrictEqual([false, false, false, false, false]);
  });
});

describe('requiresRehash', () => {
  it('ID-6 reports hashes below the current parameters or unreadable', async () => {
    const weak = await hashPassword(PASSPHRASE, fixedRandom(), FAST);
    expect(requiresRehash(weak)).toBe(true);
    expect(requiresRehash('garbage')).toBe(true);
    expect(requiresRehash('scrypt$131072$4$1$AA==$AA==')).toBe(true);
    expect(requiresRehash('scrypt$131072$8$0$AA==$AA==')).toBe(true);
  });

  it('ID-6 keeps a hash at or above the current parameters', async () => {
    const current = await hashPassword(PASSPHRASE, fixedRandom());
    expect(requiresRehash(current)).toBe(false);
    expect(requiresRehash('scrypt$262144$16$2$AA==$AA==')).toBe(false);
  });
});
