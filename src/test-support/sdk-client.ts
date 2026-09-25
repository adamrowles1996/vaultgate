/**
 * The MCP client SDK's OAuth flow driven against the in-process app: a host
 * provider whose state survives the redirect leg, a fetch router, the
 * browser half of the handshake and a bearer probe at the real `/mcp`.
 */
import {
  auth,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import { expect } from 'vitest';

import { postJsonRpc } from './mcp-client.ts';
import {
  createOAuthHarness,
  type HarnessOptions,
  type OAuthHarness,
  PUBLIC_URL,
  RESOURCE,
} from './oauth-harness.ts';
import { cimdDocument, parseConsentForm } from './oauth-http.ts';

import type { Browser as CookieBrowser } from './browser.ts';

export const CIMD_ID = 'https://agent.example.com/.well-known/oauth-client.json';
const REDIRECT = 'https://agent.example.com/callback';
export const DESK = { clientId: 'desk', clientName: 'Desk', redirectUris: [REDIRECT] };
export const SCOPE = 'vault:read vault:reveal';
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

export interface ProviderOptions {
  readonly client?: StoredOAuthClientInformation;
  readonly cimd?: boolean;
  readonly metadata?: Partial<OAuthClientMetadata>;
  readonly redirectUrl?: string;
}

/**
 * The provider an MCP host would implement; state survives the redirect leg.
 */
export class TestProvider implements OAuthClientProvider {
  #verifier = '';
  #client: StoredOAuthClientInformation | undefined;
  #tokens: StoredOAuthTokens | undefined;
  #discovery: OAuthDiscoveryState | undefined;
  readonly redirectUrl: string;
  readonly clientMetadata: OAuthClientMetadata;
  clientMetadataUrl?: string;
  authorizationUrl: URL | undefined;
  readonly invalidated: string[] = [];

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

  /**
   * What a real host does when the server reports `invalid_grant`: forget the
   * tokens so the retry starts a fresh authorization instead of replaying.
   */
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): void {
    this.invalidated.push(scope);
    if (scope === 'tokens' || scope === 'all') {
      this.#tokens = undefined;
    }
  }
}

export type FetchFunction = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Routes the SDK's fetches to the in-process app; a CIMD host is the only
 * other origin and is served from the harness's document map.
 */
export function fetchThrough(harness: OAuthHarness): FetchFunction {
  return (input, init) => {
    const url = new URL(String(input));
    if (url.origin === new URL(PUBLIC_URL).origin) {
      return Promise.resolve(harness.app.request(new Request(url.href, init)));
    }
    const document = harness.cimd.get(url.href);
    return Promise.resolve(document === undefined ? new Response('', { status: 404 }) : document());
  };
}

export interface Callback {
  readonly code: string;
  readonly state: string | null;
  readonly iss: string | null;
}

export function authorizationPath(provider: TestProvider): string {
  const url = provider.authorizationUrl ?? new URL(PUBLIC_URL);
  return `${url.pathname}${url.search}`;
}

/**
 * The human half: open the authorization URL signed in and approve, submitting what a browser
 * would: the scopes the page renders ticked, plus the hidden `vault:read`. The unticked
 * **Not requested** offers (OAUTH-18) stay out.
 */
export async function approveInBrowser(
  harness: OAuthHarness,
  provider: TestProvider,
  browser: CookieBrowser = harness.browser(harness.signIn()),
): Promise<Callback> {
  const started = await browser.get(authorizationPath(provider));
  expect(started.status).toBe(302);
  const page = await browser.get(started.headers.get('location') ?? '');
  const form = parseConsentForm(await page.text());
  const fields: Record<string, string> = {
    request_id: form.requestId,
    csrf: form.csrfToken,
    decision: 'approve',
  };
  for (const input of form.html.matchAll(/<input[^>]*name="scope:([\w:.]+)"[^>]*>/g)) {
    if (/ checked|type="hidden"/.test(input[0])) {
      fields[`scope:${input[1] ?? ''}`] = 'on';
    }
  }
  const decided = await browser.submit('/oauth/authorize', fields);
  expect(decided.status).toBe(302);
  const callback = new URL(decided.headers.get('location') ?? '');
  expect(callback.searchParams.get('error')).toBeNull();
  return {
    code: callback.searchParams.get('code') ?? '',
    state: callback.searchParams.get('state'),
    iss: callback.searchParams.get('iss'),
  };
}

export interface Handshake {
  readonly provider: TestProvider;
  readonly tokens: StoredOAuthTokens;
}

/**
 * Discovery → registration → authorization redirect → consent → exchange.
 */
export async function handshake(
  harness: OAuthHarness,
  provider: TestProvider,
  browser?: CookieBrowser,
): Promise<Handshake> {
  const fetchFunction = fetchThrough(harness);
  const first = await auth(provider, { serverUrl: RESOURCE, scope: SCOPE, fetchFn: fetchFunction });
  expect(first).toBe('REDIRECT');
  const callback = await approveInBrowser(harness, provider, browser);
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

export async function mcpStatus(harness: OAuthHarness, token: string | undefined): Promise<number> {
  const reply = await postJsonRpc(harness.app, INITIALIZE, token === undefined ? {} : { token });
  return reply.status;
}

export function newHarness(options: HarnessOptions = {}): OAuthHarness {
  const harness = createOAuthHarness(options);
  harness.cimd.set(CIMD_ID, cimdDocument(CIMD_ID, [REDIRECT]));
  return harness;
}

export async function authorizeAs(
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
