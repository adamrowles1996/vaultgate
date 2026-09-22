import { describe, expect, it } from 'vitest';

import { openTestRepos, TEST_OPERATOR_ID } from '../../test-support/oauth-store.ts';

import type { ClientRecord } from './clients.ts';
import type { TokenRecord } from './tokens.ts';

const CLIENT: ClientRecord = {
  id: 'c1',
  clientId: 'client-a',
  mode: 'dcr',
  clientName: 'A',
  redirectUris: ['https://a.example/cb'],
  metadata: { client_name: 'A' },
  createdAt: 10,
  revokedAt: undefined,
};

function token(overrides: Partial<TokenRecord>): TokenRecord {
  return {
    id: 't1',
    tokenHash: 'h1',
    kind: 'access',
    familyId: 'fam',
    parentId: undefined,
    replacedById: undefined,
    clientId: 'client-a',
    consentId: 'consent-1',
    scopes: ['vault:read'],
    resource: 'https://v/mcp',
    issuedAt: 1,
    expiresAt: 2,
    revokedAt: undefined,
    lastUsedAt: undefined,
    ...overrides,
  };
}

function seeded(): ReturnType<typeof openTestRepos> {
  const repos = openTestRepos();
  repos.clients.upsert(CLIENT);
  repos.consents.insert({
    id: 'consent-1',
    operatorId: TEST_OPERATOR_ID,
    clientId: 'client-a',
    scopes: ['vault:read'],
    grantedAt: 5,
    revokedAt: undefined,
  });
  return repos;
}

describe('clients repository', () => {
  it('round-trips a client and refreshes name, redirects and metadata on conflict', () => {
    const repos = openTestRepos();
    repos.clients.upsert(CLIENT);
    expect(repos.clients.findByClientId('client-a')).toStrictEqual(CLIENT);
    repos.clients.upsert({ ...CLIENT, id: 'ignored', clientName: 'B', redirectUris: ['https://b.example/cb'], createdAt: 99 });
    expect(repos.clients.findByClientId('client-a')).toStrictEqual({
      ...CLIENT,
      clientName: 'B',
      redirectUris: ['https://b.example/cb'],
    });
    expect(repos.clients.findByClientId('missing')).toBeUndefined();
  });

  it('stores an unnamed, revoked client', () => {
    const repos = openTestRepos();
    repos.clients.upsert({ ...CLIENT, clientName: undefined, revokedAt: 3 });
    expect(repos.clients.findByClientId('client-a')).toMatchObject({ clientName: undefined, revokedAt: 3 });
  });
});

describe('cimd cache repository', () => {
  it('round-trips and replaces an entry', () => {
    const repos = openTestRepos();
    const entry = { clientId: 'https://a/c.json', document: { a: 1 }, fetchedAt: 1, expiresAt: 2, etag: undefined };
    repos.cimdCache.put(entry);
    expect(repos.cimdCache.find(entry.clientId)).toStrictEqual(entry);
    repos.cimdCache.put({ ...entry, document: { a: 2 }, etag: 'e' });
    expect(repos.cimdCache.find(entry.clientId)).toStrictEqual({ ...entry, document: { a: 2 }, etag: 'e' });
    expect(repos.cimdCache.find('none')).toBeUndefined();
  });
});

describe('consents repository', () => {
  it('finds the active consent, widens it, revokes once and lists connected clients', () => {
    const repos = seeded();
    expect(repos.consents.findActive(TEST_OPERATOR_ID, 'client-a')?.id).toBe('consent-1');
    expect(repos.consents.findActive(TEST_OPERATOR_ID, 'other')).toBeUndefined();
    repos.consents.updateScopes('consent-1', ['vault:read', 'vault:reveal']);
    expect(repos.consents.findById('consent-1')?.scopes).toStrictEqual(['vault:read', 'vault:reveal']);
    repos.tokens.insert(token({ lastUsedAt: 77 }));
    repos.tokens.insert(token({ id: 't2', tokenHash: 'h2', lastUsedAt: 99 }));
    expect(repos.consents.listConnected(TEST_OPERATOR_ID)).toStrictEqual([
      {
        id: 'consent-1',
        operatorId: TEST_OPERATOR_ID,
        clientId: 'client-a',
        scopes: ['vault:read', 'vault:reveal'],
        grantedAt: 5,
        revokedAt: undefined,
        clientName: 'A',
        lastUsedAt: 99,
      },
    ]);
    expect(repos.consents.revoke('consent-1', 50)).toBe(1);
    expect(repos.consents.revoke('consent-1', 51)).toBe(0);
    expect(repos.consents.revoke('nope', 51)).toBe(0);
    expect(repos.consents.findById('consent-1')?.revokedAt).toBe(50);
    expect(repos.consents.findActive(TEST_OPERATOR_ID, 'client-a')).toBeUndefined();
    expect(repos.consents.listConnected(TEST_OPERATOR_ID)).toStrictEqual([]);
    expect(repos.consents.findById('nope')).toBeUndefined();
  });

  it('lists a connected client that was never used and has no name', () => {
    const repos = seeded();
    repos.clients.upsert({ ...CLIENT, clientName: undefined });
    expect(repos.consents.listConnected(TEST_OPERATOR_ID)[0]).toMatchObject({ clientName: undefined, lastUsedAt: undefined });
  });
});

describe('authorization codes repository', () => {
  it('OAUTH-21 claims a code exactly once and reports reuse and unknown codes', () => {
    const repos = seeded();
    repos.authorizationCodes.insert({
      codeHash: 'code-hash',
      clientId: 'client-a',
      consentId: 'consent-1',
      redirectUri: 'https://a.example/cb',
      codeChallenge: 'chal',
      resource: 'https://v/mcp',
      scopes: ['vault:read'],
      expiresAt: 100,
      usedAt: undefined,
    });
    const first = repos.authorizationCodes.claim('code-hash', 20);
    expect(first).toStrictEqual({
      kind: 'claimed',
      code: {
        codeHash: 'code-hash',
        clientId: 'client-a',
        consentId: 'consent-1',
        redirectUri: 'https://a.example/cb',
        codeChallenge: 'chal',
        resource: 'https://v/mcp',
        scopes: ['vault:read'],
        expiresAt: 100,
        usedAt: 20,
      },
    });
    expect(repos.authorizationCodes.claim('code-hash', 21).kind).toBe('reused');
    expect(repos.authorizationCodes.claim('other', 21)).toStrictEqual({ kind: 'unknown' });
  });

  it('stores a code without a resource', () => {
    const repos = seeded();
    repos.authorizationCodes.insert({
      codeHash: 'x',
      clientId: 'client-a',
      consentId: 'consent-1',
      redirectUri: 'https://a.example/cb',
      codeChallenge: 'chal',
      resource: undefined,
      scopes: [],
      expiresAt: 1,
      usedAt: 3,
    });
    expect(repos.authorizationCodes.claim('x', 4)).toMatchObject({ kind: 'reused', code: { resource: undefined, usedAt: 3 } });
  });
});

describe('tokens repository', () => {
  it('round-trips, rotates once, and revokes by id, family and consent', () => {
    const repos = seeded();
    const first = token({});
    repos.tokens.insert(first);
    repos.tokens.insert(token({ id: 't2', tokenHash: 'h2', kind: 'refresh', parentId: 't1' }));
    repos.tokens.insert(token({ id: 't3', tokenHash: 'h3', familyId: 'other', resource: undefined }));
    expect(repos.tokens.findByHash('h1')).toStrictEqual(first);
    expect(repos.tokens.findByHash('h3')?.resource).toBeUndefined();
    expect(repos.tokens.findByHash('none')).toBeUndefined();
    expect(repos.tokens.markReplaced('t2', 't3')).toBe(true);
    expect(repos.tokens.markReplaced('t2', 't1')).toBe(false);
    expect(repos.tokens.findByHash('h2')).toMatchObject({ replacedById: 't3', parentId: 't1' });
    repos.tokens.touchLastUsed('t1', 123);
    expect(repos.tokens.findByHash('h1')?.lastUsedAt).toBe(123);
    expect(repos.tokens.revokeById('t1', 200)).toBe(1);
    expect(repos.tokens.revokeById('t1', 201)).toBe(0);
    expect(repos.tokens.revokeFamily('fam', 202)).toBe(1);
    expect(repos.tokens.revokeByConsent('consent-1', 203)).toBe(1);
    expect(repos.tokens.findByHash('h3')?.revokedAt).toBe(203);
  });
});

describe('pending authorizations repository', () => {
  it('OAUTH-17 stores, finds and deletes a pending request', () => {
    const repos = openTestRepos();
    const record = { id: 'p1', sessionBindingHash: 'bind', parameters: { client_id: 'x' }, expiresAt: 9 };
    repos.pendingAuthorizations.insert(record);
    expect(repos.pendingAuthorizations.find('p1')).toStrictEqual(record);
    repos.pendingAuthorizations.delete('p1');
    expect(repos.pendingAuthorizations.find('p1')).toBeUndefined();
  });
});
