import { describe, expect, it } from 'vitest';

import { Rc4, rc4 } from './rc4.ts';

/**
 * The published RC4 vectors (the ones the original description circulated
 * with, quoted in every reference since). Taking them from outside this
 * repository is the point: a misreading of the key schedule cannot be
 * mirrored in the expectation.
 */
const VECTORS: readonly (readonly [string, string, string])[] = [
  ['Key', 'Plaintext', 'bbf316e8d940af0ad3'],
  ['Wiki', 'pedia', '1021bf0420'],
  ['Secret', 'Attack at dawn', '45a01f645fc35b383552544b9bf5'],
];

describe('rc4', () => {
  it('ACT-89 answers every published RC4 test vector', () => {
    const ciphertexts = VECTORS.map(([key, plaintext]) =>
      rc4(Buffer.from(key, 'ascii'), Buffer.from(plaintext, 'ascii')).toString('hex'),
    );
    expect(ciphertexts).toStrictEqual(VECTORS.map((vector) => vector[2]));
  });

  it('ACT-89 decrypts what it encrypted, because the keystream is symmetric', () => {
    const key = Buffer.from('canary-rc4-key', 'ascii');
    const message = Buffer.from('a WS-Management envelope', 'utf8');
    const sealed = new Rc4(key).apply(message);
    expect(sealed.equals(message)).toBe(false);
    expect(new Rc4(key).apply(sealed)).toStrictEqual(message);
  });

  it('ACT-89 keeps one keystream across calls, so a handle seals then signs', () => {
    const key = Buffer.from('Key', 'ascii');
    const running = new Rc4(key);
    const first = running.apply(Buffer.from('Plain', 'ascii'));
    const second = running.apply(Buffer.from('text', 'ascii'));
    expect(Buffer.concat([first, second]).toString('hex')).toBe('bbf316e8d940af0ad3');
    // A fresh handle restarts the keystream; that is what makes the state matter.
    expect(new Rc4(key).apply(Buffer.from('text', 'ascii')).toString('hex')).not.toBe(
      second.toString('hex'),
    );
  });
});
