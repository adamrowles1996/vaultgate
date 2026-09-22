import { describe, expect, it } from 'vitest';

import { createOAuthHarness, formBody, type OAuthHarness, OPERATOR_ID, RESOURCE } from '../test-support/oauth-harness.ts';

import { CREDENTIAL_PREFIX, hashCredential, mintCredential } from './credentials.ts';

const CLIENT_ID = 'vg_c_revoke-client';

interface Family {
  readonly access: string;
  readonly refresh: string;
}

function issueFamily(harness: OAuthHarness, familyId: string, fill: number): Family {
  harness.repos.clients.upsert({ id: `client-${fill}`, clientId: CLIENT_ID, mode: 'dcr', clientName: 'Agent', redirectUris: ['https://a.example/cb'], metadata: {}, createdAt: 0, revokedAt: undefined });
  if (harness.repos.consents.findById('consent-1') === undefined) {
    harness.repos.consents.insert({ id: 'consent-1', operatorId: OPERATOR_ID, clientId: CLIENT_ID, scopes: ['vault:read'], grantedAt: 0, revokedAt: undefined });
  }
  const access = mintCredential(CREDENTIAL_PREFIX.accessToken, (bytes) => Buffer.alloc(bytes, fill));
  const refresh = mintCredential(CREDENTIAL_PREFIX.refreshToken, (bytes) => Buffer.alloc(bytes, fill + 1));
  const base = { familyId, parentId: undefined, replacedById: undefined, clientId: CLIENT_ID, consentId: 'consent-1', scopes: ['vault:read'], resource: RESOURCE, issuedAt: 0, expiresAt: 9e12, revokedAt: undefined, lastUsedAt: undefined };
  harness.repos.tokens.insert({ ...base, id: `a-${fill}`, tokenHash: hashCredential(access), kind: 'access' });
  harness.repos.tokens.insert({ ...base, id: `r-${fill}`, tokenHash: hashCredential(refresh), kind: 'refresh' });
  return { access, refresh };
}

async function revoke(harness: OAuthHarness, token: string, hint?: string): Promise<Response> {
  return harness.request('/oauth/revoke', formBody({ token, ...(hint === undefined ? {} : { token_type_hint: hint }) }));
}

function revokedAt(harness: OAuthHarness, token: string): number | undefined {
  return harness.repos.tokens.findByHash(hashCredential(token))?.revokedAt;
}

describe('POST /oauth/revoke', () => {
  it('OAUTH-29 revokes an access token by itself and answers 200 {}', async () => {
    const harness = createOAuthHarness();
    const family = issueFamily(harness, 'fam-1', 10);
    const response = await revoke(harness, family.access, 'access_token');
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toStrictEqual({});
    expect(revokedAt(harness, family.access)).toBe(harness.now());
    expect(revokedAt(harness, family.refresh)).toBeUndefined();
    expect(harness.audit).toStrictEqual([expect.objectContaining({ action: 'token_revoked', clientId: CLIENT_ID, details: { kind: 'access', revoked: 1 } })]);
  });

  it('OAUTH-29 revokes a refresh token with its whole family', async () => {
    const harness = createOAuthHarness();
    const family = issueFamily(harness, 'fam-1', 20);
    const other = issueFamily(harness, 'fam-2', 30);
    await revoke(harness, family.refresh);
    expect(revokedAt(harness, family.access)).toBe(harness.now());
    expect(revokedAt(harness, family.refresh)).toBe(harness.now());
    expect(revokedAt(harness, other.access)).toBeUndefined();
    expect(harness.audit.at(-1)).toMatchObject({ details: { kind: 'refresh', revoked: 2 } });
  });

  it('OAUTH-29 answers 200 {} for unknown, malformed or already revoked tokens without auditing', async () => {
    const harness = createOAuthHarness();
    const family = issueFamily(harness, 'fam-1', 40);
    await revoke(harness, family.access);
    const count = harness.audit.length;
    for (const token of [family.access, 'garbage', mintCredential(CREDENTIAL_PREFIX.accessToken, (bytes) => Buffer.alloc(bytes, 99))]) {
      const response = await revoke(harness, token);
      expect(response.status).toBe(200);
      expect(await response.json()).toStrictEqual({});
    }
    expect(harness.audit).toHaveLength(count + 1);
  });

  it('OAUTH-29 requires the token parameter and a form body', async () => {
    const harness = createOAuthHarness();
    const missing = await harness.request('/oauth/revoke', formBody({}));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: 'invalid_request', error_description: 'parameter "token" is required' });
    const json = await harness.request('/oauth/revoke', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(json.status).toBe(400);
  });

  it('OAUTH-30 revoking a consent revokes every token of that client and makes the bearer unusable', async () => {
    const harness = createOAuthHarness();
    const family = issueFamily(harness, 'fam-1', 50);
    const other = issueFamily(harness, 'fam-2', 60);
    expect((await harness.server.tokenVerifier.verify(family.access)).ok).toBe(true);
    expect(harness.server.revokeConsent(OPERATOR_ID, 'consent-1')).toBe(4);
    for (const token of [family.access, family.refresh, other.access, other.refresh]) {
      expect(revokedAt(harness, token)).toBe(harness.now());
    }
    expect((await harness.server.tokenVerifier.verify(family.access)).ok).toBe(false);
    expect(harness.audit.at(-1)).toMatchObject({ action: 'consent_revoked', operatorId: OPERATOR_ID, clientId: CLIENT_ID, details: { revoked: 4 } });
  });
});
