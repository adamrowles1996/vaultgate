/**
 * Where and how an adapter token is obtained (spec §14.3, §14.3a): the
 * exchange plan of one credential mode, derived from its document alone.
 * `graph` is the Microsoft Graph preset of ACT-130 — the token URL fixed by
 * the tenant, the client secret in the form, the token as
 * `Authorization: Bearer` — and `oauth2` takes every part from its document
 * (ACT-124, ACT-125, ACT-128). The token service (`./adapter.ts`) and the
 * exchange (`./token.ts`) read the plan, never the mode.
 */
import { GRAPH_TOKEN_HOST, type GraphCredential } from './document.ts';
import { type OAuth2Credential, oauth2TokenEndpoint } from './oauth2-document.ts';

/**
A credential mode whose value is an access token the adapter obtains: `graph` or `oauth2`.
*/
export type TokenCredential = GraphCredential | OAuth2Credential;

/**
The field names access tokens are redacted under: `[redacted:graph.access_token]` and `[redacted:oauth2.access_token]`.
*/
export const GRAPH_ACCESS_TOKEN_FIELD = 'graph.access_token';
export const OAUTH2_ACCESS_TOKEN_FIELD = 'oauth2.access_token';

/**
The header an access token goes in: `<name>: <prefix><access_token>` (ACT-128).
*/
export interface TokenHeader {
  readonly name: string;
  readonly prefix: string;
}

export interface ExchangePlan {
  readonly url: string;
  /**
  The token endpoint's host, resolved and validated each time a token is exchanged (ACT-55, ACT-56).
  */
  readonly host: string;
  readonly grant: TokenCredential['grant'];
  readonly clientId: string;
  /**
  ACT-125: `post` sends the client id and secret in the form; `basic` in an HTTP Basic header.
  */
  readonly clientAuth: 'post' | 'basic';
  /**
  Sent only when set (ACT-125); `graph` always has one, its default included.
  */
  readonly scope: string | undefined;
  readonly secretField: string;
  readonly refreshTokenField: string | undefined;
  readonly accessTokenField: string;
  readonly header: TokenHeader;
}

const GRAPH_HEADER: TokenHeader = { name: 'authorization', prefix: 'Bearer ' };

/**
ACT-82: Microsoft's token endpoint for the tenant, the tenant escaped into the path.
*/
export function graphTokenUrl(tenantId: string): string {
  return `https://${GRAPH_TOKEN_HOST}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

export function exchangePlan(credential: TokenCredential): ExchangePlan {
  const common = {
    grant: credential.grant,
    clientId: credential.client_id,
    scope: credential.scope,
    secretField: credential.secret_field,
    refreshTokenField: credential.refresh_token_field,
  };
  if (credential.mode === 'graph') {
    return {
      ...common,
      url: graphTokenUrl(credential.tenant_id),
      host: GRAPH_TOKEN_HOST,
      clientAuth: 'post',
      accessTokenField: GRAPH_ACCESS_TOKEN_FIELD,
      header: GRAPH_HEADER,
    };
  }
  return {
    ...common,
    url: credential.token_url,
    host: oauth2TokenEndpoint(credential).host,
    clientAuth: credential.client_auth,
    accessTokenField: OAUTH2_ACCESS_TOKEN_FIELD,
    header: { name: credential.name, prefix: credential.prefix },
  };
}
