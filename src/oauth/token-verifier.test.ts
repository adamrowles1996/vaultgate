import { describe, expect, it } from 'vitest';

import { openTestRepos, TEST_OPERATOR_ID } from '../test-support/oauth-store.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { CREDENTIAL_PREFIX, hashCredential, mintCredential } from './credentials.ts';
import { StoreTokenVerifier } from './token-verifier.ts';

import type { TokenRecord } from './repositories/tokens.ts';

const PUBLIC_URL = 'https://vault.example.com';
const RESOURCE = `${PUBLIC_URL}/mcp`;

interface Setup {
  readonly verifier: StoreTokenVerifier;
  readonly repos: ReturnType<typeof openTestRepos>;
  readonly token: string;
  readonly advance: (ms: number) => void;
}

function setup(overrides: Partial<TokenRecord> = {}, consentRevokedAt?: number): Setup {
  const repos = openTestRepos();
  let at = 1_000_000;
  repos.clients.upsert({
    id: 'c',
    clientId: 'client-a',
    mode: 'dcr',
    clientName: 'Agent A',
    redirectUris: ['https://a.example/cb'],
    metadata: {},
    createdAt: 0,
    revokedAt: undefined,
  });
  repos.consents.insert({
    id: 'consent-1',
    operatorId: TEST_OPERATOR_ID,
    clientId: 'client-a',
    scopes: ['vault:read'],
    grantedAt: 0,
    revokedAt: consentRevokedAt,
  });
  const token = mintCredential(CREDENTIAL_PREFIX.accessToken, (bytes) => Buffer.alloc(bytes, 9));
  repos.tokens.insert({
    id: 't1',
    tokenHash: hashCredential(token),
    kind: 'access',
    familyId: 'fam',
    parentId: undefined,
    replacedById: undefined,
    clientId: 'client-a',
    consentId: 'consent-1',
    scopes: ['vault:read', 'vault:reveal'],
    resource: RESOURCE,
    issuedAt: at,
    expiresAt: at + 3_600_000,
    revokedAt: undefined,
    lastUsedAt: undefined,
    ...overrides,
  });
  const verifier = new StoreTokenVerifier({ publicUrl: PUBLIC_URL, repos, now: () => at });
  return {
    verifier,
    repos,
    token,
    advance: (ms) => {
      at += ms;
    },
  };
}

describe('StoreTokenVerifier', () => {
  it('OAUTH-32 accepts a live token and returns the verified shape', async () => {
    const { verifier, token } = setup();
    const verified = unwrapOk(await verifier.verify(token));
    expect(verified).toStrictEqual({
      tokenId: hashCredential(token).slice(0, 12),
      clientId: 'client-a',
      clientName: 'Agent A',
      subject: TEST_OPERATOR_ID,
      scopes: ['vault:read', 'vault:reveal'],
      expiresAt: 1_000_000 + 3_600_000,
      resource: RESOURCE,
    });
  });

  it('OAUTH-34 rejects anything without the vg_at_ prefix as malformed', async () => {
    const { verifier } = setup();
    for (const candidate of ['', 'vg_at_', 'vg_rt_abc', 'eyJhbGciOiJSUzI1NiJ9.e30.sig', 'Bearer x']) {
      expect(unwrapFail(await verifier.verify(candidate)).reason).toBe('malformed');
    }
  });

  it('OAUTH-32 rejects an unknown token', async () => {
    const { verifier } = setup();
    const unknown = mintCredential(CREDENTIAL_PREFIX.accessToken, (bytes) => Buffer.alloc(bytes, 1));
    expect(unwrapFail(await verifier.verify(unknown)).reason).toBe('unknown');
  });

  it('OAUTH-32 rejects a refresh token presented as a bearer', async () => {
    const { verifier, token } = setup({ kind: 'refresh' });
    expect(unwrapFail(await verifier.verify(token)).reason).toBe('unknown');
  });

  it('OAUTH-32 rejects a revoked token', async () => {
    const { verifier, token } = setup({ revokedAt: 5 });
    expect(unwrapFail(await verifier.verify(token)).reason).toBe('revoked');
  });

  it('OAUTH-32 rejects an expired token', async () => {
    const { verifier, token, advance } = setup();
    advance(3_600_000);
    expect(unwrapFail(await verifier.verify(token)).reason).toBe('expired');
  });

  it('OAUTH-32 rejects a token issued for another resource', async () => {
    const { verifier, token } = setup({ resource: 'https://other.example.com/mcp' });
    const rejection = unwrapFail(await verifier.verify(token));
    expect(rejection.reason).toBe('unknown');
    expect(rejection.message).toBe('token issued for another resource');
  });

  it('OAUTH-30 rejects a token whose consent was revoked', async () => {
    const { verifier, token } = setup({}, 7);
    expect(unwrapFail(await verifier.verify(token)).message).toBe('consent revoked');
  });

  it('OAUTH-35 updates last_used_at at most once per minute', async () => {
    const { verifier, token, repos, advance } = setup();
    const hash = hashCredential(token);
    await verifier.verify(token);
    expect(repos.tokens.findByHash(hash)?.lastUsedAt).toBe(1_000_000);
    advance(30_000);
    await verifier.verify(token);
    expect(repos.tokens.findByHash(hash)?.lastUsedAt).toBe(1_000_000);
    advance(30_000);
    await verifier.verify(token);
    expect(repos.tokens.findByHash(hash)?.lastUsedAt).toBe(1_060_000);
  });

  it('falls back to the client id when the client row has no name', async () => {
    const { verifier, token, repos } = setup();
    repos.clients.upsert({
      id: 'c',
      clientId: 'client-a',
      mode: 'dcr',
      clientName: undefined,
      redirectUris: [],
      metadata: {},
      createdAt: 0,
      revokedAt: undefined,
    });
    expect(unwrapOk(await verifier.verify(token)).clientName).toBe('client-a');
  });
});
