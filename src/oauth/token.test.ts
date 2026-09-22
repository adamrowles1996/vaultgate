import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import {
  createOAuthHarness,
  type Exchange,
  formBody,
  type OAuthHarness,
  OPERATOR_ID,
  parseJson,
  RESOURCE,
} from '../test-support/oauth-harness.ts';

import { CREDENTIAL_PREFIX, hashCredential, mintCredential } from './credentials.ts';
import { createTokenHandler, type TokenEndpointDependencies } from './token.ts';

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const CLIENT_ID = 'vg_c_test-client';
const REDIRECT = 'https://agent.example.com/cb';
const DAY_MS = 86_400_000;
const noop = (): undefined => undefined;

interface SeedOptions {
  readonly expiresIn?: number;
  readonly consentRevokedAt?: number;
}

interface Seeded {
  readonly harness: OAuthHarness;
  readonly code: string;
}

interface TokenReply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

const counters = { code: 0, id: 0 };

function seed(harness: OAuthHarness, options: SeedOptions = {}): string {
  const at = harness.now();
  harness.ensureOperator();
  harness.repos.clients.upsert({
    id: 'client-row',
    clientId: CLIENT_ID,
    mode: 'dcr',
    clientName: 'Agent',
    redirectUris: [REDIRECT],
    metadata: {},
    createdAt: at,
    revokedAt: undefined,
  });
  if (harness.repos.consents.findById('consent-1') === undefined) {
    harness.repos.consents.insert({
      id: 'consent-1',
      operatorId: OPERATOR_ID,
      clientId: CLIENT_ID,
      scopes: ['vault:read', 'vault:reveal'],
      grantedAt: at,
      revokedAt: options.consentRevokedAt,
    });
  }
  counters.code += 1;
  const code = mintCredential(CREDENTIAL_PREFIX.authorizationCode, (bytes) => {
    const buffer = Buffer.alloc(bytes);
    buffer.writeUInt32BE(counters.code, 0);
    return buffer;
  });
  harness.repos.authorizationCodes.insert({
    codeHash: hashCredential(code),
    clientId: CLIENT_ID,
    consentId: 'consent-1',
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
    resource: RESOURCE,
    scopes: ['vault:read', 'vault:reveal'],
    expiresAt: at + (options.expiresIn ?? 300_000),
    usedAt: undefined,
  });
  return code;
}

function seeded(options: SeedOptions = {}): Seeded {
  const harness = createOAuthHarness();
  return { harness, code: seed(harness, options) };
}

function codeGrant(
  code: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const fields: Record<string, string | undefined> = {
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: RESOURCE,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function refreshGrant(
  refreshToken: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    ...extra,
  };
}

async function post(harness: OAuthHarness, fields: Record<string, string>): Promise<TokenReply> {
  const exchange: Exchange = await harness.exchange('/oauth/token', formBody(fields));
  return { status: exchange.status, headers: exchange.headers, body: parseJson(exchange) };
}

async function errorOf(
  harness: OAuthHarness,
  fields: Record<string, string>,
): Promise<Record<string, unknown>> {
  const reply = await post(harness, fields);
  return reply.body;
}

async function redeem(harness: OAuthHarness, code: string): Promise<Record<string, string>> {
  const reply = await post(harness, codeGrant(code));
  expect(reply.status).toBe(200);
  return Object.fromEntries(Object.entries(reply.body).map(([key, value]) => [key, String(value)]));
}

function revokedAt(harness: OAuthHarness, token: string): number | undefined {
  return harness.repos.tokens.findByHash(hashCredential(token))?.revokedAt;
}

function claimKind(harness: OAuthHarness, code: string): string {
  return harness.repos.authorizationCodes.claim(hashCredential(code), 0).kind;
}

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
