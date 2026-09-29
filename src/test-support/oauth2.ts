/**
 * What the `oauth2` adapter's contract tests run against (ACT-75): the
 * documents an `oauth2` target is made of, with a token endpoint on a host
 * of its own so the graph fixtures' transport (`./graph.ts`) tells it apart
 * from the API, and the answers real token endpoints give besides the
 * standard one — a quoted `expires_in`, none at all, a refusal inside a
 * `200` (Zoho Books) — each carrying canary strings for ACT-53.
 */
import {
  type OAuth2Credential,
  oauth2CredentialSchema,
} from '../actions/connectors/graph/oauth2-document.ts';

import { graphRequests, graphTransport, isTokenRequest, tokenRequests } from './graph.ts';

import type { Answer, FakeTransport } from './http-connector.ts';
import type { PinnedRequest } from '../net/pinned-https.ts';

export const OAUTH2_TOKEN_HOST = 'auth.example.com';
export const OAUTH2_TOKEN_URL = `https://${OAUTH2_TOKEN_HOST}/oauth/v2/token`;
export const OAUTH2_BASE_URL = 'https://api.example.com/v1';
export const OAUTH2_CLIENT = '1000.EXAMPLE-CLIENT';

export const OAUTH2_CANARY = {
  accessToken: 'CANARY-OAUTH2-ACCESS-TOKEN-5e1d',
  rotatedRefreshToken: 'CANARY-OAUTH2-ROTATED-REFRESH-8b3f',
  secondAccessToken: 'CANARY-OAUTH2-ACCESS-TOKEN-SECOND-2c7a',
} as const;

/**
A client-credentials document on the fixture token endpoint, with every default a save would apply.
*/
export function oauth2Credential(
  overrides: Readonly<Record<string, unknown>> = {},
): OAuth2Credential {
  return oauth2CredentialSchema.parse({
    mode: 'oauth2',
    token_url: OAUTH2_TOKEN_URL,
    grant: 'client_credentials',
    client_id: OAUTH2_CLIENT,
    secret_field: 'password',
    ...overrides,
  });
}

/**
The same document for the refresh-token grant, its refresh token in `custom.refresh`.
*/
export function oauth2RefreshCredential(
  overrides: Readonly<Record<string, unknown>> = {},
): OAuth2Credential {
  return oauth2Credential({
    grant: 'refresh_token',
    refresh_token_field: 'custom.refresh',
    ...overrides,
  });
}

/**
A grant as an endpoint that is not Microsoft may answer it: `expires_in` quoted, missing or null.
*/
export function oauth2Grant(fields: Readonly<Record<string, unknown>> = {}): Response {
  return Response.json({ access_token: OAUTH2_CANARY.accessToken, ...fields });
}

/**
Zoho Books' refusal of a spent refresh token: `200`, an error code and no token.
*/
export function refusedWithOk(error: string): Response {
  return Response.json({ error });
}

type Answering = (request: PinnedRequest, index: number) => Answer;

export function oauth2Transport(token: Answering, api: Answering): FakeTransport {
  return graphTransport(token, api, OAUTH2_TOKEN_HOST);
}

export function isOAuth2TokenRequest(request: PinnedRequest): boolean {
  return isTokenRequest(request, OAUTH2_TOKEN_HOST);
}

export function oauth2TokenRequests(fake: FakeTransport): readonly PinnedRequest[] {
  return tokenRequests(fake, OAUTH2_TOKEN_HOST);
}

export function apiRequests(fake: FakeTransport): readonly PinnedRequest[] {
  return graphRequests(fake, OAUTH2_TOKEN_HOST);
}
