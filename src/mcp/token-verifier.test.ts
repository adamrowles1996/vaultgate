import { describe, expect, it } from 'vitest';

import { unwrapFail } from '../test-support/result.ts';

import { RejectAllTokenVerifier, TokenRejection, type TokenVerifier } from './token-verifier.ts';

describe('RejectAllTokenVerifier', () => {
  it('OAUTH-34 rejects every token until an authorization server is wired', async () => {
    const verifier: TokenVerifier = new RejectAllTokenVerifier();
    const rejection = unwrapFail(await verifier.verify('vg_at_anything'));
    expect(rejection).toBeInstanceOf(TokenRejection);
    expect(rejection.name).toBe('TokenRejection');
    expect(rejection.reason).toBe('unknown');
  });
});
