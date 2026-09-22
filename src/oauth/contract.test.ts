/**
 * Contract tests (spec §11.2): the MCP client SDK's own OAuth helpers drive
 * the real application through an injected fetch for all three registration
 * paths, and the resulting bearer is accepted by the real `/mcp` route.
 */
import {
  auth,
  OAuthError,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  RegistrationRejectedError,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import { postJsonRpc } from '../test-support/mcp-client.ts';
import {
  cimdDocument,
  createOAuthHarness,
  formBody,
  type HarnessOptions,
  type OAuthHarness,
  parseConsentForm,
  PUBLIC_URL,
  RESOURCE,
} from '../test-support/oauth-harness.ts';

import { hashCredential } from './credentials.ts';

const CIMD_ID = 'https://agent.example.com/.well-known/oauth-client.json';
const REDIRECT = 'https://agent.example.com/callback';
const DESK = { clientId: 'desk', clientName: 'Desk', redirectUris: [REDIRECT] };
const SCOPE = 'vault:read vault:reveal';
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'contract', version: '1' },
  },
};

interface ProviderOptions {
  readonly client?: StoredOAuthClientInformation;
  readonly cimd?: boolean;
  readonly metadata?: Partial<OAuthClientMetadata>;
  readonly redirectUrl?: string;
}

/**
 * The provider an MCP host would implement; state survives the redirect leg.
 */
class TestProvider implements OAuthClientProvider {
  #verifier = '';
  #client: StoredOAuthClientInformation | undefined;
  #tokens: StoredOAuthTokens | undefined;
  #discovery: OAuthDiscoveryState | undefined;
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  clientMetadataUrl?: string;
  authorizationUrl: URL | undefined;

  constructor(options: ProviderOptions = {}) {
    this.redirectUrl = options.redirectUrl ?? REDIRECT;
    this.clientMetadata = {
      redirect_uris: [this.redirectUrl],
      client_name: 'SDK Agent',
      token_endpoint_auth_method: 'none',
      ...options.metadata,
    };
    this.#client = options.client;
    if (options.cimd === true) {
      this.clientMetadataUrl = CIMD_ID;
    }
  }

  state(): string {
    return 'state-123';
  }

  clientInformation(): StoredOAuthClientInformation | undefined {
    return this.#client;
  }

  saveClientInformation(information: StoredOAuthClientInformation): void {
    this.#client = information;
  }

  tokens(): StoredOAuthTokens | undefined {
    return this.#tokens;
  }

  saveTokens(tokens: StoredOAuthTokens): void {
    this.#tokens = tokens;
  }

  redirectToAuthorization(url: URL): void {
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string): void {
    this.#verifier = verifier;
  }

  codeVerifier(): string {
    return this.#verifier;
  }

  saveDiscoveryState(state: OAuthDiscoveryState): void {
    this.#discovery = state;
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.#discovery;
  }
}

type FetchFunction = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Routes the SDK's fetches to the in-process app; a CIMD host is the only
 * other origin and is served from the harness's document map.
 */
function fetchThrough(harness: OAuthHarness): FetchFunction {
  return (input, init) => {
    const url = new URL(String(input));
    if (url.origin === new URL(PUBLIC_URL).origin) {
      return Promise.resolve(harness.app.request(new Request(url.href, init)));
    }
    const document = harness.cimd.get(url.href);
    return Promise.resolve(document === undefined ? new Response('', { status: 404 }) : document());
  };
}

interface Callback {
  readonly code: string;
  readonly state: string | null;
  readonly iss: string | null;
}

function authorizationPath(provider: TestProvider): string {
  const url = provider.authorizationUrl ?? new URL(PUBLIC_URL);
  return `${url.pathname}${url.search}`;
}

/**
 * The human half: open the authorization URL signed in, approve every scope.
 */
async function approveInBrowser(harness: OAuthHarness, provider: TestProvider): Promise<Callback> {
  const browser = harness.signIn();
  const started = await harness.exchange(authorizationPath(provider), { headers: browser.headers });
  expect(started.status).toBe(302);
  const page = await harness.exchange(started.headers.get('location') ?? '', {
    headers: browser.headers,
  });
  const form = parseConsentForm(page.text);
  const fields: Record<string, string> = {
    request_id: form.requestId,
    csrf_token: form.csrfToken,
    decision: 'approve',
  };
  for (const scope of form.html.matchAll(/name="scope:([\w:]+)"/g)) {
    fields[`scope:${scope[1] ?? ''}`] = 'on';
  }
  const decided = await harness.exchange('/oauth/authorize', formBody(fields, browser.headers));
  expect(decided.status).toBe(302);
  const callback = new URL(decided.headers.get('location') ?? '');
  expect(callback.searchParams.get('error')).toBeNull();
  return {
    code: callback.searchParams.get('code') ?? '',
    state: callback.searchParams.get('state'),
    iss: callback.searchParams.get('iss'),
  };
}

interface Handshake {
  readonly provider: TestProvider;
  readonly tokens: StoredOAuthTokens;
}

/**
 * Discovery → registration → authorization redirect → consent → exchange.
 */
async function handshake(harness: OAuthHarness, provider: TestProvider): Promise<Handshake> {
  const fetchFunction = fetchThrough(harness);
  const first = await auth(provider, { serverUrl: RESOURCE, scope: SCOPE, fetchFn: fetchFunction });
  expect(first).toBe('REDIRECT');
  const callback = await approveInBrowser(harness, provider);
  expect(callback.state).toBe('state-123');
  expect(callback.iss).toBe(PUBLIC_URL);
  const second = await auth(provider, {
    serverUrl: RESOURCE,
    authorizationCode: callback.code,
    iss: callback.iss ?? '',
    fetchFn: fetchFunction,
  });
  expect(second).toBe('AUTHORIZED');
  const tokens = provider.tokens();
  expect(tokens).toBeDefined();
  return { provider, tokens: tokens ?? { access_token: '', token_type: '' } };
}

async function mcpStatus(harness: OAuthHarness, token: string | undefined): Promise<number> {
  const reply = await postJsonRpc(harness.app, INITIALIZE, { token });
  return reply.status;
}

function newHarness(options: HarnessOptions = {}): OAuthHarness {
  const harness = createOAuthHarness(options);
  harness.cimd.set(CIMD_ID, cimdDocument(CIMD_ID, [REDIRECT]));
  return harness;
}

async function authorizeAs(
  harness: OAuthHarness,
  provider: TestProvider,
): Promise<{ status: number; location: string | null; text: string }> {
  await auth(provider, {
    serverUrl: RESOURCE,
    scope: 'vault:read',
    fetchFn: fetchThrough(harness),
  });
  const response = await harness.exchange(authorizationPath(provider), {
    headers: harness.signIn().headers,
  });
  return {
    status: response.status,
    location: response.headers.get('location'),
    text: response.text,
  };
}

describe('OAuth contract with the MCP client SDK', () => {
  it('completes the CIMD handshake and the token is accepted by /mcp', async () => {
    const harness = newHarness();
    const { provider, tokens } = await handshake(harness, new TestProvider({ cimd: true }));
    expect(provider.clientInformation()?.client_id).toBe(CIMD_ID);
    expect(tokens.access_token).toMatch(/^vg_at_/);
    expect(tokens.refresh_token).toMatch(/^vg_rt_/);
    expect(tokens.scope).toBe(SCOPE);
    expect(harness.repos.clients.findByClientId(CIMD_ID)?.mode).toBe('cimd');
    const verified = await harness.server.tokenVerifier.verify(tokens.access_token);
    expect(verified.ok).toBe(true);
    expect(await mcpStatus(harness, tokens.access_token)).toBe(200);
    expect(await mcpStatus(harness, undefined)).toBe(401);
  });

  it('completes the DCR handshake, minting a vg_c_ client without a secret', async () => {
    const harness = newHarness();
    const { provider, tokens } = await handshake(harness, new TestProvider());
    const information = provider.clientInformation();
    expect(information?.client_id).toMatch(/^vg_c_/);
    expect(information).not.toHaveProperty('client_secret');
    expect(harness.repos.clients.findByClientId(information?.client_id ?? '')?.mode).toBe('dcr');
    expect(await mcpStatus(harness, tokens.access_token)).toBe(200);
  });

  it('completes the pre-registered handshake', async () => {
    const harness = newHarness({ oauthClients: [DESK] });
    const provider = new TestProvider({ client: { client_id: 'desk' } });
    const { tokens } = await handshake(harness, provider);
    expect(tokens.access_token).toMatch(/^vg_at_/);
    expect(await mcpStatus(harness, tokens.access_token)).toBe(200);
  });

  it('OAUTH-25 refreshes through the SDK, rotating the refresh token', async () => {
    const harness = newHarness();
    const { provider, tokens } = await handshake(harness, new TestProvider({ cimd: true }));
    harness.advance(60_000);
    const result = await auth(provider, { serverUrl: RESOURCE, fetchFn: fetchThrough(harness) });
    expect(result).toBe('AUTHORIZED');
    const rotated = provider.tokens();
    expect(rotated?.refresh_token).not.toBe(tokens.refresh_token);
    expect(await mcpStatus(harness, rotated?.access_token)).toBe(200);
  });

  it('OAUTH-25 a replayed refresh token is refused and the whole family is revoked', async () => {
    const harness = newHarness();
    const { provider, tokens } = await handshake(harness, new TestProvider({ cimd: true }));
    const fetchFunction = fetchThrough(harness);
    const rotated = await auth(provider, { serverUrl: RESOURCE, fetchFn: fetchFunction });
    expect(rotated).toBe('AUTHORIZED');
    const fresh = provider.tokens();
    provider.saveTokens(tokens);
    await expect(
      auth(provider, { serverUrl: RESOURCE, fetchFn: fetchFunction }),
    ).rejects.toMatchObject({
      message: 'the refresh token has already been used',
    });
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

  it('OAUTH-32 an expired access token is refused by /mcp while the refresh token still works', async () => {
    const harness = newHarness();
    const { provider, tokens } = await handshake(harness, new TestProvider({ cimd: true }));
    harness.advance(3_600_000);
    expect(await mcpStatus(harness, tokens.access_token)).toBe(401);
    const result = await auth(provider, { serverUrl: RESOURCE, fetchFn: fetchThrough(harness) });
    expect(result).toBe('AUTHORIZED');
    expect(await mcpStatus(harness, provider.tokens()?.access_token)).toBe(200);
  });

  it('OAUTH-30 revoking the consent makes every token of the client unusable', async () => {
    const harness = newHarness();
    const { provider, tokens } = await handshake(harness, new TestProvider({ cimd: true }));
    const consent = harness.repos.consents.findActive('operator-1', CIMD_ID);
    expect(harness.server.revokeConsent('operator-1', consent?.id ?? '')).toBe(2);
    expect(await mcpStatus(harness, tokens.access_token)).toBe(401);
    await expect(
      auth(provider, { serverUrl: RESOURCE, fetchFn: fetchThrough(harness) }),
    ).rejects.toBeInstanceOf(OAuthError);
  });

  it('OAUTH-34 a token the server did not issue is refused', async () => {
    const harness = newHarness();
    expect(await mcpStatus(harness, 'eyJhbGciOiJub25lIn0.e30.')).toBe(401);
  });
});
