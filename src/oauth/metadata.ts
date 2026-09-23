import { enabledScopes, type Scope, type ScopeSwitches } from '../scopes/registry.ts';

export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly revocation_endpoint: string;
  readonly registration_endpoint: string;
  readonly response_types_supported: readonly ['code'];
  readonly grant_types_supported: readonly ['authorization_code', 'refresh_token'];
  readonly code_challenge_methods_supported: readonly ['S256'];
  readonly token_endpoint_auth_methods_supported: readonly ['none'];
  readonly revocation_endpoint_auth_methods_supported: readonly ['none'];
  readonly scopes_supported: readonly Scope[];
  readonly client_id_metadata_document_supported: true;
  readonly authorization_response_iss_parameter_supported: true;
}

export interface MetadataConfig extends ScopeSwitches {
  readonly publicUrl: string;
}

export const METADATA_PATH = '/.well-known/oauth-authorization-server';

export const AUTHORIZE_PATH = '/oauth/authorize';
export const TOKEN_PATH = '/oauth/token';
export const REVOKE_PATH = '/oauth/revoke';
export const REGISTER_PATH = '/oauth/register';

/**
 * The canonical resource (RFC 8707): `${PUBLIC_URL}/mcp`, no trailing slash.
 */
export function canonicalResource(publicUrl: string): string {
  return `${publicUrl}/mcp`;
}

/**
 * OAUTH-2. `scopes_supported` lists the scopes this deployment will grant
 * (OAUTH-16) so a client that requests everything advertised succeeds;
 * `offline_access` never appears (OAUTH-4).
 */
export function authorizationServerMetadata(config: MetadataConfig): AuthorizationServerMetadata {
  return {
    issuer: config.publicUrl,
    authorization_endpoint: `${config.publicUrl}${AUTHORIZE_PATH}`,
    token_endpoint: `${config.publicUrl}${TOKEN_PATH}`,
    revocation_endpoint: `${config.publicUrl}${REVOKE_PATH}`,
    registration_endpoint: `${config.publicUrl}${REGISTER_PATH}`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: enabledScopes(config),
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/**
 * OAUTH-3: JSON, cacheable for five minutes, readable cross-origin.
 */
export const METADATA_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'Access-Control-Allow-Origin': '*',
};
