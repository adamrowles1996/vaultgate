import { auth, RegistrationRejectedError } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import { PUBLIC_URL, RESOURCE } from '../test-support/oauth-harness.ts';
import { cimdDocument } from '../test-support/oauth-http.ts';
import {
  approveInBrowser,
  authorizationPath,
  authorizeAs,
  CIMD_ID,
  fetchThrough,
  handshake,
  mcpStatus,
  newHarness,
  SCOPE,
  TestProvider,
} from '../test-support/sdk-client.ts';

import { hashCredential } from './credentials.ts';

describe('OAuth contract negative cases', () => {
  it('OAUTH-25 a replayed refresh token revokes the whole family and the SDK re-authorizes', async () => {
    const harness = newHarness();
    const { provider, tokens } = await handshake(harness, new TestProvider({ cimd: true }));
    const fetchFunction = fetchThrough(harness);
    const rotated = await auth(provider, { serverUrl: RESOURCE, fetchFn: fetchFunction });
    expect(rotated).toBe('AUTHORIZED');
    const fresh = provider.tokens();
    provider.saveTokens(tokens);
    const replayed = await auth(provider, {
      serverUrl: RESOURCE,
      scope: SCOPE,
      fetchFn: fetchFunction,
    });
    expect(replayed).toBe('REDIRECT');
    expect(provider.invalidated).toStrictEqual(['tokens']);
    expect(await mcpStatus(harness, tokens.access_token)).toBe(401);
    expect(await mcpStatus(harness, fresh?.access_token)).toBe(401);
  });

  it('OAUTH-22 exchanging the same code twice fails with invalid_grant and revokes the first tokens', async () => {
    const harness = newHarness();
    const provider = new TestProvider({ cimd: true });
    const fetchFunction = fetchThrough(harness);
    await auth(provider, { serverUrl: RESOURCE, scope: 'vault:read', fetchFn: fetchFunction });
    const callback = await approveInBrowser(harness, provider);
    const exchange = {
      serverUrl: RESOURCE,
      authorizationCode: callback.code,
      iss: PUBLIC_URL,
      fetchFn: fetchFunction,
    };
    await auth(provider, exchange);
    const first = provider.tokens();
    await expect(auth(provider, exchange)).rejects.toMatchObject({
      message: 'the authorization code has already been used',
    });
    expect(await mcpStatus(harness, first?.access_token)).toBe(401);
    const record = harness.repos.tokens.findByHash(hashCredential(first?.access_token ?? ''));
    expect(record?.revokedAt).toBe(harness.now());
  });

  it('OAUTH-16 a scope the deployment does not grant is refused at the authorization endpoint', async () => {
    const harness = newHarness();
    const provider = new TestProvider({ cimd: true });
    const scope = 'vault:read vault:write';
    await auth(provider, { serverUrl: RESOURCE, scope, fetchFn: fetchThrough(harness) });
    const response = await harness.exchange(authorizationPath(provider), {
      headers: harness.signIn().headers,
    });
    const location = new URL(response.headers.get('location') ?? '');
    expect(location.searchParams.get('error')).toBe('invalid_scope');
    expect(location.searchParams.get('iss')).toBe(PUBLIC_URL);
  });

  it('OAUTH-5 DCR with a confidential authentication method is rejected', async () => {
    const harness = newHarness();
    const metadata = { token_endpoint_auth_method: 'client_secret_basic' };
    const provider = new TestProvider({ metadata });
    await expect(
      auth(provider, { serverUrl: RESOURCE, fetchFn: fetchThrough(harness) }),
    ).rejects.toBeInstanceOf(RegistrationRejectedError);
  });

  it('T6 a CIMD client whose host resolves to a private address is refused on an error page', async () => {
    const harness = newHarness({ lookup: () => Promise.resolve(['10.0.0.8']) });
    const response = await authorizeAs(harness, new TestProvider({ cimd: true }));
    expect(response.status).toBe(400);
    expect(response.location).toBeNull();
    expect(response.text).toContain('does not resolve to a public address');
  });

  it('T22 a redirect the cached CIMD document lacks forces a refetch; one the fresh document lacks is refused', async () => {
    const harness = newHarness();
    await handshake(harness, new TestProvider({ cimd: true }));
    const moved = 'https://agent.example.com/moved';
    harness.cimd.set(CIMD_ID, cimdDocument(CIMD_ID, [moved]));
    const accepted = await authorizeAs(
      harness,
      new TestProvider({ cimd: true, redirectUrl: moved }),
    );
    expect(accepted.status).toBe(302);
    expect(accepted.location).toMatch(/^\/oauth\/authorize\//);
    const refused = await authorizeAs(harness, new TestProvider({ cimd: true }));
    expect(refused.status).toBe(400);
    expect(refused.text).toContain('redirect_uri is not registered for this client');
    expect(harness.fetchedUrls).toStrictEqual([CIMD_ID, CIMD_ID, CIMD_ID]);
  });

  it('OAUTH-30 revoking the consent makes every token of the client unusable', async () => {
    const harness = newHarness();
    const { provider, tokens } = await handshake(harness, new TestProvider({ cimd: true }));
    const consent = harness.repos.consents.findActive('operator-1', CIMD_ID);
    expect(harness.server.revokeConsent('operator-1', consent?.id ?? '')).toBe(2);
    expect(await mcpStatus(harness, tokens.access_token)).toBe(401);
    const fetchFunction = fetchThrough(harness);
    const result = await auth(provider, {
      serverUrl: RESOURCE,
      scope: SCOPE,
      fetchFn: fetchFunction,
    });
    expect(result).toBe('REDIRECT');
  });

  it('OAUTH-34 a token the server did not issue is refused', async () => {
    const harness = newHarness();
    expect(await mcpStatus(harness, 'eyJhbGciOiJub25lIn0.e30.')).toBe(401);
  });
});
