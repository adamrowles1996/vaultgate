import { describe, expect, it } from 'vitest';

import { RESOURCE } from '../test-support/oauth-harness.ts';
import { parseJson } from '../test-support/oauth-http.ts';
import {
  claimKind,
  CLIENT_ID,
  codeGrant,
  DAY_MS,
  errorOf,
  post,
  redeem,
  revokedAt,
  seeded,
  VERIFIER,
} from '../test-support/token-fixtures.ts';

import { CREDENTIAL_PREFIX, hashCredential, mintCredential } from './credentials.ts';

describe('POST /oauth/token authorization_code', () => {
  it('OAUTH-21/24/26 redeems a code for opaque tokens stored as hashes, with no-store and an audit event', async () => {
    const { harness, code } = seeded();
    const reply = await post(harness, codeGrant(code));
    expect(reply.status).toBe(200);
    expect(reply.headers.get('cache-control')).toBe('no-store');
    expect(reply.headers.get('pragma')).toBe('no-cache');
    expect(reply.headers.get('access-control-allow-origin')).toBe('*');
    expect(reply.body).toStrictEqual({
      access_token: expect.stringMatching(/^vg_at_[\w-]{43}$/) as string,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: expect.stringMatching(/^vg_rt_[\w-]{43}$/) as string,
      scope: 'vault:read vault:reveal',
      resource: RESOURCE,
    });
    const accessToken = String(reply.body['access_token']);
    const access = harness.repos.tokens.findByHash(hashCredential(accessToken));
    const refresh = harness.repos.tokens.findByHash(
      hashCredential(String(reply.body['refresh_token'])),
    );
    expect(access).toMatchObject({
      kind: 'access',
      familyId: hashCredential(code),
      expiresAt: harness.now() + 3_600_000,
      scopes: ['vault:read', 'vault:reveal'],
    });
    expect(refresh).toMatchObject({
      kind: 'refresh',
      familyId: hashCredential(code),
      expiresAt: harness.now() + 30 * DAY_MS,
    });
    expect(JSON.stringify(access)).not.toContain(accessToken);
    expect(harness.audit).toHaveLength(1);
    expect(harness.audit[0]).toMatchObject({
      action: 'token_issued',
      clientId: CLIENT_ID,
      tokenPrefix: accessToken.slice(0, 14),
      details: { scopes: ['vault:read', 'vault:reveal'] },
    });
    const verified = await harness.server.tokenVerifier.verify(accessToken);
    expect(verified.ok).toBe(true);
  });

  it.each(['code', 'client_id', 'redirect_uri', 'code_verifier', 'resource'])(
    'OAUTH-21 requires %s and leaves the code unspent',
    async (name) => {
      const { harness, code } = seeded();
      const reply = await post(harness, codeGrant(code, { [name]: undefined }));
      expect(reply.status).toBe(400);
      expect(reply.body).toStrictEqual({
        error: 'invalid_request',
        error_description: `parameter "${name}" is required`,
      });
      expect(claimKind(harness, code)).toBe('claimed');
    },
  );

  it('OAUTH-15 rejects a wrong resource with invalid_target before spending the code', async () => {
    const { harness, code } = seeded();
    const body = await errorOf(
      harness,
      codeGrant(code, { resource: 'https://other.example.com/mcp' }),
    );
    expect(body['error']).toBe('invalid_target');
    expect(claimKind(harness, code)).toBe('claimed');
  });

  it.each([[{ client_id: 'vg_c_other' }], [{ redirect_uri: 'https://agent.example.com/other' }]])(
    'OAUTH-21 rejects a mismatched binding %j with invalid_grant and spends the code',
    async (overrides) => {
      const { harness, code } = seeded();
      const reply = await post(harness, codeGrant(code, overrides));
      expect(reply.status).toBe(400);
      expect(reply.body).toStrictEqual({
        error: 'invalid_grant',
        error_description: 'the authorization code does not match this request',
      });
      expect(claimKind(harness, code)).toBe('reused');
    },
  );

  it('OAUTH-23 rejects a wrong or malformed PKCE verifier', async () => {
    const wrong = seeded();
    const mismatch = await errorOf(
      wrong.harness,
      codeGrant(wrong.code, { code_verifier: `${VERIFIER.slice(0, -1)}X` }),
    );
    expect(mismatch['error_description']).toBe('the PKCE code_verifier does not match');
    const short = seeded();
    const malformed = await errorOf(
      short.harness,
      codeGrant(short.code, { code_verifier: 'short' }),
    );
    expect(malformed['error']).toBe('invalid_grant');
  });

  it('OAUTH-21 rejects an expired code', async () => {
    const { harness, code } = seeded({ expiresIn: 1000 });
    harness.advance(1000);
    const body = await errorOf(harness, codeGrant(code));
    expect(body['error_description']).toBe('the authorization code does not match this request');
  });

  it('OAUTH-21 rejects an unknown code or one without the vg_ac_ prefix', async () => {
    const { harness } = seeded();
    const unknown = mintCredential(CREDENTIAL_PREFIX.authorizationCode, (bytes) =>
      Buffer.alloc(bytes, 3),
    );
    const unknownBody = await errorOf(harness, codeGrant(unknown));
    expect(unknownBody['error_description']).toBe('the authorization code is invalid');
    const malformedBody = await errorOf(harness, codeGrant('not-a-code'));
    expect(malformedBody['error_description']).toBe('the authorization code is invalid');
  });

  it('OAUTH-30 rejects a code whose consent has been revoked', async () => {
    const { harness, code } = seeded({ consentRevokedAt: 1 });
    const body = await errorOf(harness, codeGrant(code));
    expect(body['error']).toBe('invalid_grant');
  });

  it('OAUTH-22 reuse of a code revokes every token issued from it', async () => {
    const { harness, code } = seeded();
    const tokens = await redeem(harness, code);
    const reply = await post(harness, codeGrant(code));
    expect(reply.status).toBe(400);
    expect(reply.body).toStrictEqual({
      error: 'invalid_grant',
      error_description: 'the authorization code has already been used',
    });
    expect(revokedAt(harness, tokens['access_token'] ?? '')).toBe(harness.now());
    expect(revokedAt(harness, tokens['refresh_token'] ?? '')).toBe(harness.now());
    expect(harness.audit.at(-1)).toMatchObject({
      action: 'token_revoked',
      details: { reason: 'authorization code reuse', revoked: 2 },
    });
    const verified = await harness.server.tokenVerifier.verify(tokens['access_token'] ?? '');
    expect(verified.ok).toBe(false);
  });

  it('OAUTH-27 answers unsupported grant types and non-form bodies with RFC 6749 errors', async () => {
    const { harness } = seeded();
    const password = await errorOf(harness, { grant_type: 'password' });
    expect(password).toStrictEqual({
      error: 'unsupported_grant_type',
      error_description: 'grant_type is not supported',
    });
    const empty = await errorOf(harness, {});
    expect(empty['error']).toBe('unsupported_grant_type');
    const json = await harness.exchange('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(json.status).toBe(400);
    expect(parseJson(json)).toMatchObject({ error: 'invalid_request' });
  });

  it('OAUTH-28 limits the endpoint to 60 requests per ip per minute with Retry-After', async () => {
    const { harness } = seeded();
    for (let index = 0; index < 60; index += 1) {
      await post(harness, { grant_type: 'nope' });
    }
    const reply = await post(harness, { grant_type: 'nope' });
    expect(reply.status).toBe(429);
    expect(reply.headers.get('retry-after')).toBe('1');
    expect(reply.body['error']).toBe('temporarily_unavailable');
  });
});
