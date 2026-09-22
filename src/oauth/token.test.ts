import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createOAuthHarness, formBody, type OAuthHarness, OPERATOR_ID, RESOURCE } from '../test-support/oauth-harness.ts';

import { CREDENTIAL_PREFIX, hashCredential, mintCredential } from './credentials.ts';
import { createTokenHandler, type TokenEndpointDependencies } from './token.ts';

const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const CLIENT_ID = 'vg_c_test-client';
const REDIRECT = 'https://agent.example.com/cb';

interface Seeded {
  readonly harness: OAuthHarness;
  readonly code: string;
}

function seed(harness: OAuthHarness, overrides: { scopes?: readonly string[]; expiresIn?: number; consentRevokedAt?: number } = {}): string {
  const at = harness.now();
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
      revokedAt: overrides.consentRevokedAt,
    });
  }
  const code = mintCredential(CREDENTIAL_PREFIX.authorizationCode, (bytes) => {
    const buffer = Buffer.alloc(bytes);
    buffer.writeUInt32BE(at % 1_000_000, 0);
    buffer.writeUInt32BE(harness.repos.tokens.findByHash('never') === undefined ? Date.now() % 1_000_000 : 0, 4);
    return buffer;
  });
  harness.repos.authorizationCodes.insert({
    codeHash: hashCredential(code),
    clientId: CLIENT_ID,
    consentId: 'consent-1',
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
    resource: RESOURCE,
    scopes: overrides.scopes ?? ['vault:read', 'vault:reveal'],
    expiresAt: at + (overrides.expiresIn ?? 300_000),
    usedAt: undefined,
  });
  return code;
}

function seeded(overrides: Parameters<typeof seed>[1] = {}): Seeded {
  const harness = createOAuthHarness();
  return { harness, code: seed(harness, overrides) };
}

function codeGrant(code: string, overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const fields: Record<string, string | undefined> = {
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: RESOURCE,
    ...overrides,
  };
  return Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

async function post(harness: OAuthHarness, fields: Record<string, string>): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await harness.request('/oauth/token', formBody(fields));
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers };
}

async function redeem(harness: OAuthHarness, code: string): Promise<Record<string, unknown>> {
  const { status, body } = await post(harness, codeGrant(code));
  expect(status).toBe(200);
  return body;
}

describe('POST /oauth/token authorization_code', () => {
  it('OAUTH-21/24/26 redeems a code for opaque tokens stored as hashes, with no-store and an audit event', async () => {
    const { harness, code } = seeded();
    const { status, body, headers } = await post(harness, codeGrant(code));
    expect(status).toBe(200);
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.get('pragma')).toBe('no-cache');
    expect(headers.get('access-control-allow-origin')).toBe('*');
    expect(body).toStrictEqual({
      access_token: expect.stringMatching(/^vg_at_[\w-]{43}$/),
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: expect.stringMatching(/^vg_rt_[\w-]{43}$/),
      scope: 'vault:read vault:reveal',
      resource: RESOURCE,
    });
    const access = harness.repos.tokens.findByHash(hashCredential(String(body['access_token'])));
    const refresh = harness.repos.tokens.findByHash(hashCredential(String(body['refresh_token'])));
    expect(access).toMatchObject({ kind: 'access', familyId: hashCredential(code), expiresAt: harness.now() + 3_600_000, scopes: ['vault:read', 'vault:reveal'] });
    expect(refresh).toMatchObject({ kind: 'refresh', familyId: hashCredential(code), expiresAt: harness.now() + 30 * 86_400_000 });
    expect(JSON.stringify(harness.repos.tokens.findByHash(hashCredential(String(body['access_token']))))).not.toContain(String(body['access_token']));
    expect(harness.audit).toStrictEqual([
      expect.objectContaining({ action: 'token_issued', clientId: CLIENT_ID, tokenPrefix: String(body['access_token']).slice(0, 14), details: { scopes: ['vault:read', 'vault:reveal'] } }),
    ]);
    const verified = await harness.server.tokenVerifier.verify(String(body['access_token']));
    expect(verified.ok).toBe(true);
  });

  it.each([
    ['code', 'invalid_request'],
    ['client_id', 'invalid_request'],
    ['redirect_uri', 'invalid_request'],
    ['code_verifier', 'invalid_request'],
    ['resource', 'invalid_request'],
  ])('OAUTH-21 requires %s', async (name, error) => {
    const { harness, code } = seeded();
    const { status, body } = await post(harness, codeGrant(code, { [name]: undefined }));
    expect(status).toBe(400);
    expect(body).toStrictEqual({ error, error_description: `parameter "${name}" is required` });
    expect(harness.repos.authorizationCodes.claim(hashCredential(code), 0).kind).toBe('claimed');
  });

  it('OAUTH-15 rejects a wrong resource with invalid_target before spending the code', async () => {
    const { harness, code } = seeded();
    const { body } = await post(harness, codeGrant(code, { resource: 'https://other.example.com/mcp' }));
    expect(body['error']).toBe('invalid_target');
    expect(harness.repos.authorizationCodes.claim(hashCredential(code), 0).kind).toBe('claimed');
  });

  it.each([
    [{ client_id: 'vg_c_other' }],
    [{ redirect_uri: 'https://agent.example.com/other' }],
  ])('OAUTH-21 rejects a mismatched binding %j with invalid_grant and spends the code', async (overrides) => {
    const { harness, code } = seeded();
    const { status, body } = await post(harness, codeGrant(code, overrides));
    expect(status).toBe(400);
    expect(body).toStrictEqual({ error: 'invalid_grant', error_description: 'the authorization code does not match this request' });
    expect(harness.repos.authorizationCodes.claim(hashCredential(code), 0).kind).toBe('reused');
  });

  it('OAUTH-23 rejects a wrong or malformed PKCE verifier', async () => {
    const wrong = seeded();
    expect((await post(wrong.harness, codeGrant(wrong.code, { code_verifier: `${VERIFIER.slice(0, -1)}X` }))).body['error_description']).toBe('the PKCE code_verifier does not match');
    const short = seeded();
    expect((await post(short.harness, codeGrant(short.code, { code_verifier: 'short' }))).body['error']).toBe('invalid_grant');
  });

  it('OAUTH-21 rejects an expired code', async () => {
    const { harness, code } = seeded({ expiresIn: 1000 });
    harness.advance(1000);
    expect((await post(harness, codeGrant(code))).body['error_description']).toBe('the authorization code does not match this request');
  });

  it('OAUTH-21 rejects an unknown code or one without the vg_ac_ prefix', async () => {
    const { harness } = seeded();
    const unknown = mintCredential(CREDENTIAL_PREFIX.authorizationCode, (bytes) => Buffer.alloc(bytes, 3));
    expect((await post(harness, codeGrant(unknown))).body['error_description']).toBe('the authorization code is invalid');
    expect((await post(harness, codeGrant('not-a-code'))).body['error_description']).toBe('the authorization code is invalid');
  });

  it('OAUTH-30 rejects a code whose consent has been revoked', async () => {
    const { harness, code } = seeded({ consentRevokedAt: 1 });
    expect((await post(harness, codeGrant(code))).body['error']).toBe('invalid_grant');
  });

  it('OAUTH-22 reuse of a code revokes every token issued from it', async () => {
    const { harness, code } = seeded();
    const tokens = await redeem(harness, code);
    const { status, body } = await post(harness, codeGrant(code));
    expect(status).toBe(400);
    expect(body).toStrictEqual({ error: 'invalid_grant', error_description: 'the authorization code has already been used' });
    expect(harness.repos.tokens.findByHash(hashCredential(String(tokens['access_token'])))?.revokedAt).toBe(harness.now());
    expect(harness.repos.tokens.findByHash(hashCredential(String(tokens['refresh_token'])))?.revokedAt).toBe(harness.now());
    expect(harness.audit.at(-1)).toMatchObject({ action: 'token_revoked', details: { reason: 'authorization code reuse', revoked: 2 } });
    const verified = await harness.server.tokenVerifier.verify(String(tokens['access_token']));
    expect(verified.ok).toBe(false);
  });

  it('OAUTH-27 answers unsupported grant types and non-form bodies with RFC 6749 errors', async () => {
    const { harness } = seeded();
    expect((await post(harness, { grant_type: 'password' })).body).toStrictEqual({ error: 'unsupported_grant_type', error_description: 'grant_type is not supported' });
    expect((await post(harness, {})).body['error']).toBe('unsupported_grant_type');
    const json = await harness.request('/oauth/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(json.status).toBe(400);
    expect(await json.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('OAUTH-28 limits the endpoint to 60 requests per ip per minute with Retry-After', async () => {
    const { harness } = seeded();
    for (let index = 0; index < 60; index += 1) {
      await post(harness, { grant_type: 'nope' });
    }
    const { status, headers, body } = await post(harness, { grant_type: 'nope' });
    expect(status).toBe(429);
    expect(headers.get('retry-after')).toBe('1');
    expect(body['error']).toBe('temporarily_unavailable');
  });
});

describe('POST /oauth/token refresh_token', () => {
  function refreshGrant(refreshToken: string, extra: Record<string, string> = {}): Record<string, string> {
    return { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID, ...extra };
  }

  it('OAUTH-25 rotates within the family, records replaced_by and keeps the absolute refresh lifetime', async () => {
    const { harness, code } = seeded();
    const first = await redeem(harness, code);
    harness.advance(60_000);
    const { status, body } = await post(harness, refreshGrant(String(first['refresh_token']), { resource: RESOURCE }));
    expect(status).toBe(200);
    expect(body).toMatchObject({ token_type: 'Bearer', expires_in: 3600, scope: 'vault:read vault:reveal', resource: RESOURCE });
    expect(body['refresh_token']).not.toBe(first['refresh_token']);
    const old = harness.repos.tokens.findByHash(hashCredential(String(first['refresh_token'])));
    const fresh = harness.repos.tokens.findByHash(hashCredential(String(body['refresh_token'])));
    expect(old?.replacedById).toBe(fresh?.id);
    expect(fresh).toMatchObject({ parentId: old?.id, familyId: old?.familyId, expiresAt: old?.expiresAt });
    expect(harness.audit.at(-1)).toMatchObject({ action: 'token_refreshed', clientId: CLIENT_ID });
  });

  it('OAUTH-25 replay of a rotated refresh token revokes the whole family', async () => {
    const { harness, code } = seeded();
    const first = await redeem(harness, code);
    const rotated = (await post(harness, refreshGrant(String(first['refresh_token'])))).body;
    const { status, body } = await post(harness, refreshGrant(String(first['refresh_token'])));
    expect(status).toBe(400);
    expect(body).toStrictEqual({ error: 'invalid_grant', error_description: 'the refresh token has already been used' });
    for (const token of [first['access_token'], first['refresh_token'], rotated['access_token'], rotated['refresh_token']]) {
      expect(harness.repos.tokens.findByHash(hashCredential(String(token)))?.revokedAt).toBe(harness.now());
    }
    expect(harness.audit.at(-1)).toMatchObject({ action: 'token_revoked', details: { reason: 'refresh token replay', revoked: 3 } });
    expect((await post(harness, refreshGrant(String(rotated['refresh_token'])))).body['error_description']).toBe('the refresh token is invalid');
  });

  it('OAUTH-25 narrows scope on request and refuses to widen it', async () => {
    const { harness, code } = seeded();
    const first = await redeem(harness, code);
    const narrowed = await post(harness, refreshGrant(String(first['refresh_token']), { scope: 'vault:read' }));
    expect(narrowed.body['scope']).toBe('vault:read');
    const widened = await post(harness, refreshGrant(String(narrowed.body['refresh_token']), { scope: 'vault:read vault:reveal' }));
    expect(widened.body).toStrictEqual({ error: 'invalid_scope', error_description: 'scope cannot be widened on refresh' });
    const unknown = await post(harness, refreshGrant(String(narrowed.body['refresh_token']), { scope: 'vault:admin' }));
    expect(unknown.body['error']).toBe('invalid_scope');
  });

  it('OAUTH-25 rejects a refresh token that is missing, malformed, unknown, expired, an access token, from another client, or under a revoked consent', async () => {
    const { harness, code } = seeded();
    const first = await redeem(harness, code);
    expect((await post(harness, { grant_type: 'refresh_token' })).body['error_description']).toBe('parameter "refresh_token" is required');
    expect((await post(harness, refreshGrant('junk'))).body['error_description']).toBe('the refresh token is invalid');
    expect((await post(harness, refreshGrant(mintCredential(CREDENTIAL_PREFIX.refreshToken, (bytes) => Buffer.alloc(bytes, 5))))).body['error']).toBe('invalid_grant');
    expect((await post(harness, refreshGrant(String(first['access_token'])))).body['error_description']).toBe('the refresh token is invalid');
    expect((await post(harness, refreshGrant(String(first['refresh_token']), { client_id: 'vg_c_other' }))).body['error_description']).toBe('the refresh token is invalid');
    expect((await post(harness, refreshGrant(String(first['refresh_token']), { resource: 'https://other.example.com/mcp' }))).body['error']).toBe('invalid_target');
    harness.repos.consents.revoke('consent-1', harness.now());
    expect((await post(harness, refreshGrant(String(first['refresh_token'])))).body['error_description']).toBe('consent has been revoked');
    const expired = seeded();
    const tokens = await redeem(expired.harness, expired.code);
    expired.harness.advance(30 * 86_400_000);
    expect((await post(expired.harness, refreshGrant(String(tokens['refresh_token'])))).body['error_description']).toBe('the refresh token is invalid');
  });

  it('OAUTH-25 a lost race on rotation revokes the family rather than issuing twice', async () => {
    const { harness, code } = seeded();
    const first = await redeem(harness, code);
    const dependencies: TokenEndpointDependencies = {
      publicUrl: 'https://vault.example.com',
      enableWriteScope: false,
      repos: { ...harness.repos, tokens: { ...harness.repos.tokens, markReplaced: () => false } },
      audit: { record: () => undefined },
      rateLimiter: { take: () => ({ allowed: true }) },
      clientIp: () => 'ip',
      now: harness.now,
      random: (bytes) => Buffer.alloc(bytes, 8),
      newId: () => 'race-id',
      accessTokenTtlMs: 1000,
      refreshTokenTtlMs: 2000,
    };
    const app = new Hono().post('/t', createTokenHandler(dependencies));
    const response = await app.request('/t', formBody(refreshGrant(String(first['refresh_token']))));
    expect(await response.json()).toStrictEqual({ error: 'invalid_grant', error_description: 'the refresh token has already been used' });
    expect(harness.repos.tokens.findByHash(hashCredential(String(first['access_token'])))?.revokedAt).toBe(harness.now());
  });
});
