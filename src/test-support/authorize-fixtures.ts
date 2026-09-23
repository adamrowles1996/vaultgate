/**
 * Fixtures for the authorization endpoint tests: a harness with one CIMD and
 * one pre-registered client, the request builder and the exchange helpers.
 */
import {
  createOAuthHarness,
  type Exchange,
  type OAuthHarness,
  RESOURCE,
  type SignedIn,
} from './oauth-harness.ts';
import { cimdDocument } from './oauth-http.ts';

/**
 * RFC 7636 Appendix B challenge.
 */
export const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
export const CIMD_ID = 'https://agent.example.com/client.json';
export const CIMD_REDIRECT = 'https://agent.example.com/cb';
export const LOOPBACK_REDIRECT = 'http://127.0.0.1:4000/cb';
export const DESK = { clientId: 'desk', clientName: 'Desk', redirectUris: [LOOPBACK_REDIRECT] };
export const CONSENT_PATH = /^\/oauth\/authorize\/[\w-]{43}$/;

export type Overrides = Readonly<Record<string, string | undefined>>;

export function harnessWithClients(): OAuthHarness {
  const harness = createOAuthHarness({ oauthClients: [DESK] });
  harness.cimd.set(CIMD_ID, cimdDocument(CIMD_ID, [CIMD_REDIRECT]));
  return harness;
}

export function query(overrides: Overrides = {}, resource = RESOURCE): string {
  const parameters: Overrides = {
    response_type: 'code',
    client_id: CIMD_ID,
    redirect_uri: CIMD_REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
    resource,
    scope: 'vault:read vault:reveal',
    state: 'xyz',
    ...overrides,
  };
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(parameters)) {
    if (value !== undefined) {
      search.set(name, value);
    }
  }
  return `/oauth/authorize?${search.toString()}`;
}

export function authorize(
  harness: OAuthHarness,
  path: string,
  browser?: SignedIn,
): Promise<Exchange> {
  return harness.exchange(path, { headers: browser?.headers ?? {} });
}

export async function parkedPath(
  harness: OAuthHarness,
  browser: SignedIn,
  overrides: Overrides = {},
): Promise<string> {
  const response = await authorize(harness, query(overrides), browser);
  return response.headers.get('location') ?? '';
}

export function requestIdOf(path: string): string {
  return path.slice('/oauth/authorize/'.length);
}

export function firstCookie(response: Exchange): string {
  return (response.headers.get('set-cookie') ?? '').split(';', 1)[0] ?? '';
}
