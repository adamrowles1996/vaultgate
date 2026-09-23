import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { RESOURCE } from '../test-support/oauth-harness.ts';
import { formBody } from '../test-support/oauth-http.ts';
import {
  CLIENT_ID,
  counters,
  DAY_MS,
  errorOf,
  post,
  redeem,
  refreshGrant,
  revokedAt,
  seeded,
} from '../test-support/token-fixtures.ts';

import { CREDENTIAL_PREFIX, hashCredential, mintCredential } from './credentials.ts';
import { createTokenHandler, type TokenEndpointDependencies } from './token.ts';

const noop = (): undefined => undefined;

describe('POST /oauth/token refresh_token', () => {
  it('OAUTH-25 rotates within the family, records replaced_by and keeps the absolute refresh lifetime', async () => {
    const { harness, code } = seeded();
    const first = await redeem(harness, code);
    harness.advance(60_000);
    const reply = await post(
      harness,
      refreshGrant(first['refresh_token'] ?? '', { resource: RESOURCE }),
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'vault:read vault:reveal',
      resource: RESOURCE,
    });
    expect(reply.body['refresh_token']).not.toBe(first['refresh_token']);
    const old = harness.repos.tokens.findByHash(hashCredential(first['refresh_token'] ?? ''));
    const fresh = harness.repos.tokens.findByHash(
      hashCredential(String(reply.body['refresh_token'])),
    );
    expect(old?.replacedById).toBe(fresh?.id);
    expect(fresh).toMatchObject({
      parentId: old?.id,
      familyId: old?.familyId,
      expiresAt: old?.expiresAt,
    });
    expect(harness.audit.at(-1)).toMatchObject({ action: 'token_refreshed', clientId: CLIENT_ID });
  });

  it('OAUTH-25 replay of a rotated refresh token revokes the whole family', async () => {
    const { harness, code } = seeded();
    const first = await redeem(harness, code);
    const rotated = await post(harness, refreshGrant(first['refresh_token'] ?? ''));
    const reply = await post(harness, refreshGrant(first['refresh_token'] ?? ''));
    expect(reply.status).toBe(400);
    expect(reply.body).toStrictEqual({
      error: 'invalid_grant',
      error_description: 'the refresh token has already been used',
    });
    const family = [
      first['access_token'],
      first['refresh_token'],
      rotated.body['access_token'],
      rotated.body['refresh_token'],
    ].map(String);
    expect(family.map((token) => revokedAt(harness, token))).toStrictEqual(
      Array.from({ length: 4 }, () => harness.now()),
    );
    expect(harness.audit.at(-1)).toMatchObject({
      action: 'token_revoked',
      details: { reason: 'refresh token replay', revoked: 4 },
    });
    const dead = await errorOf(harness, refreshGrant(String(rotated.body['refresh_token'])));
    expect(dead['error_description']).toBe('the refresh token is invalid');
  });

  it('OAUTH-25 narrows scope on request and refuses to widen it', async () => {
    const { harness, code } = seeded();
    const first = await redeem(harness, code);
    const narrowed = await post(
      harness,
      refreshGrant(first['refresh_token'] ?? '', { scope: 'vault:read' }),
    );
    expect(narrowed.body['scope']).toBe('vault:read');
    const token = String(narrowed.body['refresh_token']);
    const widened = await errorOf(
      harness,
      refreshGrant(token, { scope: 'vault:read vault:reveal' }),
    );
    expect(widened).toStrictEqual({
      error: 'invalid_scope',
      error_description: 'scope cannot be widened on refresh',
    });
    const unknown = await errorOf(harness, refreshGrant(token, { scope: 'vault:admin' }));
    expect(unknown['error']).toBe('invalid_scope');
  });

  it('OAUTH-25 rejects a refresh token that is missing, malformed, unknown, an access token, from another client, or for another resource', async () => {
    const { harness, code } = seeded();
    const first = await redeem(harness, code);
    const refreshToken = first['refresh_token'] ?? '';
    const unknownToken = mintCredential(CREDENTIAL_PREFIX.refreshToken, (bytes) =>
      Buffer.alloc(bytes, 5),
    );
    const missing = await errorOf(harness, { grant_type: 'refresh_token' });
    expect(missing['error_description']).toBe('parameter "refresh_token" is required');
    const junk = await errorOf(harness, refreshGrant('junk'));
    expect(junk['error_description']).toBe('the refresh token is invalid');
    const unknown = await errorOf(harness, refreshGrant(unknownToken));
    expect(unknown['error']).toBe('invalid_grant');
    const access = await errorOf(harness, refreshGrant(first['access_token'] ?? ''));
    expect(access['error_description']).toBe('the refresh token is invalid');
    const otherClient = await errorOf(
      harness,
      refreshGrant(refreshToken, { client_id: 'vg_c_other' }),
    );
    expect(otherClient['error_description']).toBe('the refresh token is invalid');
    const otherResource = await errorOf(
      harness,
      refreshGrant(refreshToken, { resource: 'https://other.example.com/mcp' }),
    );
    expect(otherResource['error']).toBe('invalid_target');
  });

  it('OAUTH-25 requires client_id on refresh and leaves the token untouched when it is missing', async () => {
    const { harness, code } = seeded();
    const first = await redeem(harness, code);
    const refreshToken = first['refresh_token'] ?? '';
    const reply = await post(harness, { grant_type: 'refresh_token', refresh_token: refreshToken });
    expect(reply.status).toBe(400);
    expect(reply.body).toStrictEqual({
      error: 'invalid_request',
      error_description: 'parameter "client_id" is required',
    });
    const blank = await errorOf(harness, refreshGrant(refreshToken, { client_id: '' }));
    expect(blank['error_description']).toBe('parameter "client_id" is required');
    expect(revokedAt(harness, refreshToken)).toBeUndefined();
    const rotated = await post(harness, refreshGrant(refreshToken));
    expect(rotated.status).toBe(200);
  });

  it('OAUTH-25 rejects a refresh token under a revoked consent or past its absolute lifetime', async () => {
    const revoked = seeded();
    const tokens = await redeem(revoked.harness, revoked.code);
    revoked.harness.repos.consents.revoke('consent-1', revoked.harness.now());
    const body = await errorOf(revoked.harness, refreshGrant(tokens['refresh_token'] ?? ''));
    expect(body['error_description']).toBe('consent has been revoked');
    const expired = seeded();
    const expiredTokens = await redeem(expired.harness, expired.code);
    expired.harness.advance(30 * DAY_MS);
    const late = await errorOf(expired.harness, refreshGrant(expiredTokens['refresh_token'] ?? ''));
    expect(late['error_description']).toBe('the refresh token is invalid');
  });

  it('OAUTH-25 a lost race on rotation revokes the family rather than issuing twice', async () => {
    const { harness, code } = seeded();
    const first = await redeem(harness, code);
    const dependencies: TokenEndpointDependencies = {
      publicUrl: 'https://vault.example.com',
      enableWriteScope: false,
      repos: { ...harness.repos, tokens: { ...harness.repos.tokens, markReplaced: () => false } },
      audit: { record: noop },
      rateLimiter: { take: () => ({ allowed: true }) },
      clientIp: () => 'ip',
      now: harness.now,
      random: (bytes) => Buffer.alloc(bytes, 8),
      newId: () => `race-${(counters.id += 1)}`,
      accessTokenTtlMs: 1000,
      refreshTokenTtlMs: 2000,
    };
    const app = new Hono().post('/t', createTokenHandler(dependencies));
    const response = await app.request('/t', formBody(refreshGrant(first['refresh_token'] ?? '')));
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toStrictEqual({
      error: 'invalid_grant',
      error_description: 'the refresh token has already been used',
    });
    expect(revokedAt(harness, first['access_token'] ?? '')).toBe(harness.now());
  });
});
