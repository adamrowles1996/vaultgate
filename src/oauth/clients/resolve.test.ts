import { describe, expect, it, vi } from 'vitest';

import { fail, ok } from '../../result.ts';
import { openTestRepos } from '../../test-support/oauth-store.ts';
import { unwrapFail, unwrapOk } from '../../test-support/result.ts';
import { OAuthError } from '../errors.ts';

import { type CimdFetcher, createClientResolver, isCimdClientId } from './resolve.ts';

import type { CimdDocument } from './cimd-document.ts';

const CIMD_ID = 'https://agent.example.com/client.json';

function cimdDocument(redirectUris: string[]): CimdDocument {
  return { client_id: CIMD_ID, client_name: 'Agent', redirect_uris: redirectUris };
}

function setup(cimd: CimdFetcher): {
  readonly resolver: ReturnType<typeof createClientResolver>;
  readonly repos: ReturnType<typeof openTestRepos>;
} {
  const repos = openTestRepos();
  let counter = 0;
  const resolver = createClientResolver({
    preregistered: [
      {
        id: 'pre-1',
        clientId: 'desk',
        mode: 'preregistered',
        clientName: undefined,
        redirectUris: ['http://127.0.0.1:1/cb'],
        metadata: {},
        createdAt: 0,
        revokedAt: undefined,
      },
    ],
    cimd,
    clients: repos.clients,
    now: () => 42,
    newId: () => `id-${(counter += 1)}`,
  });
  return { resolver, repos };
}

describe('isCimdClientId', () => {
  it('§3.3 requires https and a non-empty path', () => {
    expect(isCimdClientId(CIMD_ID)).toBe(true);
    expect(isCimdClientId('https://agent.example.com/')).toBe(false);
    expect(isCimdClientId('https://agent.example.com')).toBe(false);
    expect(isCimdClientId('http://agent.example.com/c.json')).toBe(false);
    expect(isCimdClientId('vg_c_abc')).toBe(false);
  });
});

describe('createClientResolver', () => {
  it('§3.3 resolves a pre-registered client first, naming it by id when unnamed', async () => {
    const cimd = { fetch: vi.fn<CimdFetcher['fetch']>() };
    const { resolver } = setup(cimd);
    expect(unwrapOk(await resolver.resolve('desk'))).toStrictEqual({
      clientId: 'desk',
      clientName: 'desk',
      mode: 'preregistered',
      redirectUris: ['http://127.0.0.1:1/cb'],
      loopbackOnly: true,
    });
    expect(cimd.fetch).not.toHaveBeenCalled();
  });

  it('§3.3 resolves a CIMD client and persists it', async () => {
    const cimd = {
      fetch: vi.fn<CimdFetcher['fetch']>(() =>
        Promise.resolve(ok(cimdDocument(['https://agent.example.com/cb']))),
      ),
    };
    const { resolver, repos } = setup(cimd);
    const resolved = unwrapOk(await resolver.resolve(CIMD_ID, 'https://agent.example.com/cb'));
    expect(resolved).toStrictEqual({
      clientId: CIMD_ID,
      clientName: 'Agent',
      mode: 'cimd',
      redirectUris: ['https://agent.example.com/cb'],
      loopbackOnly: false,
    });
    expect(repos.clients.findByClientId(CIMD_ID)).toMatchObject({ id: 'id-1', mode: 'cimd', createdAt: 42 });
    await resolver.resolve(CIMD_ID);
    expect(repos.clients.findByClientId(CIMD_ID)).toMatchObject({ id: 'id-1', createdAt: 42 });
    expect(cimd.fetch).toHaveBeenCalledTimes(2);
  });

  it('T22 forces a refetch when the cached document does not list the redirect', async () => {
    const cimd = {
      fetch: vi.fn<CimdFetcher['fetch']>((_clientId, options) =>
        Promise.resolve(
          ok(cimdDocument(options?.force === true ? ['https://agent.example.com/new'] : ['https://agent.example.com/old'])),
        ),
      ),
    };
    const { resolver } = setup(cimd);
    const resolved = unwrapOk(await resolver.resolve(CIMD_ID, 'https://agent.example.com/new'));
    expect(resolved.redirectUris).toStrictEqual(['https://agent.example.com/new']);
    expect(cimd.fetch.mock.calls).toStrictEqual([[CIMD_ID], [CIMD_ID, { force: true }]]);
  });

  it('§3.3 propagates a CIMD failure', async () => {
    const cimd = {
      fetch: vi.fn<CimdFetcher['fetch']>(() =>
        Promise.resolve(fail(new OAuthError('invalid_client', 'no document'))),
      ),
    };
    const { resolver } = setup(cimd);
    expect(unwrapFail(await resolver.resolve(CIMD_ID, 'https://x/cb')).description).toBe('no document');
  });

  it('§3.3 resolves a stored dynamic client and rejects unknown, non-dynamic or revoked ids', async () => {
    const cimd = { fetch: vi.fn<CimdFetcher['fetch']>() };
    const { resolver, repos } = setup(cimd);
    const base = {
      clientName: 'Dyn',
      redirectUris: ['https://dyn.example.com/cb'],
      metadata: {},
      createdAt: 1,
      revokedAt: undefined,
    };
    repos.clients.upsert({ ...base, id: 'd1', clientId: 'vg_c_live', mode: 'dcr' });
    repos.clients.upsert({ ...base, id: 'd2', clientId: 'vg_c_gone', mode: 'dcr', revokedAt: 5 });
    repos.clients.upsert({ ...base, id: 'd3', clientId: 'stale-pre', mode: 'preregistered' });
    expect(unwrapOk(await resolver.resolve('vg_c_live')).clientName).toBe('Dyn');
    expect(unwrapFail(await resolver.resolve('vg_c_gone')).code).toBe('invalid_client');
    expect(unwrapFail(await resolver.resolve('stale-pre')).code).toBe('invalid_client');
    expect(unwrapFail(await resolver.resolve('nobody')).description).toBe('unknown client_id');
  });
});
