import { describe, expect, it } from 'vitest';

import { createSecretBox, STATE_COOKIE_INFO } from '../crypto/secret-box.ts';
import { fixedRandom } from '../test-support/identity.ts';

import { createStateCodec } from './state-cookie.ts';

const box = createSecretBox(Buffer.alloc(32, 3), STATE_COOKIE_INFO, fixedRandom());

describe('createStateCodec', () => {
  it('ID-12 ID-18 round-trips state until it expires', () => {
    const codec = createStateCodec(box);
    const state = { csrfToken: 'token', expiresAt: 1000, passwordVerifiedOperatorId: 'op-1' };
    const encoded = codec.encode(state);
    expect(codec.decode(encoded, 999)).toStrictEqual(state);
    expect(codec.decode(encoded, 1000)).toBeUndefined();
  });

  it('ID-18 rejects a missing, forged or malformed cookie', () => {
    const codec = createStateCodec(box);
    const malformed = box.seal(Buffer.from('{"csrfToken":""}'));
    expect(codec.decode(undefined, 0)).toBeUndefined();
    expect(codec.decode('v1.forged', 0)).toBeUndefined();
    expect(codec.decode(malformed, 0)).toBeUndefined();
  });
});
