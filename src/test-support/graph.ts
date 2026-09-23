/**
 * What the `graph` adapter's contract tests run against (ACT-75): a fake
 * token endpoint and a fake Graph behind one transport, told apart by host,
 * and the documents a graph target is made of. The token endpoint's answers
 * carry canary strings, so the scrub assertions of ACT-53 have something to
 * find if the adapter ever leaks one.
 */
import { GRAPH_ORIGIN, GRAPH_TOKEN_HOST } from '../actions/connectors/graph/document.ts';

import { type Answer, fakeTransport, type FakeTransport } from './http-connector.ts';

import type { GraphCredential } from '../actions/connectors/graph/document.ts';
import type { PinnedRequest } from '../net/pinned-https.ts';

export const GRAPH_TENANT = 'contoso.onmicrosoft.com';
export const GRAPH_CLIENT = '11111111-2222-3333-4444-555555555555';
export const GRAPH_BASE_URL = `${GRAPH_ORIGIN}/v1.0`;
export const TOKEN_URL = `https://${GRAPH_TOKEN_HOST}/${GRAPH_TENANT}/oauth2/v2.0/token`;

/**
An hour, the lifetime Microsoft issues; the adapter gives the token up 60 s early.
*/
export const EXPIRES_IN = 3600;

export const GRAPH_CANARY = {
  accessToken: 'CANARY-GRAPH-ACCESS-TOKEN-7b1e',
  rotatedRefreshToken: 'CANARY-GRAPH-ROTATED-REFRESH-4c2a',
  secondAccessToken: 'CANARY-GRAPH-ACCESS-TOKEN-SECOND-9d5f',
} as const;

export function graphCredential(overrides: Partial<GraphCredential> = {}): GraphCredential {
  return {
    mode: 'graph',
    tenant_id: GRAPH_TENANT,
    client_id: GRAPH_CLIENT,
    grant: 'client_credentials',
    scope: 'https://graph.microsoft.com/.default',
    secret_field: 'password',
    ...overrides,
  };
}

export interface TokenOptions {
  readonly accessToken?: string;
  readonly expiresIn?: number;
  readonly refreshToken?: string;
  /**
  Echoed back so a test can prove the client secret in the request never reaches a result (ACT-53).
  */
  readonly echo?: string | undefined;
}

export function tokenResponse(options: TokenOptions = {}): Response {
  return Response.json({
    token_type: 'Bearer',
    access_token: options.accessToken ?? GRAPH_CANARY.accessToken,
    expires_in: options.expiresIn ?? EXPIRES_IN,
    ...(options.refreshToken !== undefined && { refresh_token: options.refreshToken }),
    ...(options.echo !== undefined && { echoed: options.echo }),
  });
}

/**
The token endpoint's failure shape: an OAuth error code with the AADSTS description Microsoft sends.
*/
export function tokenFailure(status: number, error: string | undefined): Response {
  const body =
    error === undefined
      ? { unexpected: 'shape' }
      : { error, error_description: `AADSTS7000215: ${error} for this application` };
  return Response.json(body, { status });
}

export function isTokenRequest(request: PinnedRequest): boolean {
  return new URL(request.url).host === GRAPH_TOKEN_HOST;
}

export function formOf(request: PinnedRequest): URLSearchParams {
  return new URLSearchParams(request.body?.toString('utf8') ?? '');
}

export function tokenRequests(fake: FakeTransport): readonly PinnedRequest[] {
  return fake.requests.filter((request) => isTokenRequest(request));
}

export function graphRequests(fake: FakeTransport): readonly PinnedRequest[] {
  return fake.requests.filter((request) => !isTokenRequest(request));
}

/**
One transport for both fakes: the token endpoint and Graph itself each see their own request index.
*/
export function graphTransport(
  token: (request: PinnedRequest, index: number) => Answer,
  api: (request: PinnedRequest, index: number) => Answer,
): FakeTransport {
  let tokens = 0;
  let calls = 0;
  return fakeTransport((request) => {
    if (isTokenRequest(request)) {
      tokens += 1;
      return token(request, tokens - 1);
    }
    calls += 1;
    return api(request, calls - 1);
  });
}
