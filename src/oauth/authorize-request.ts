import { fail, ok, type Result } from '../result.ts';

import { OAuthError } from './errors.ts';
import { readQuery, type FormFields } from './form.ts';
import { canonicalResource } from './metadata.ts';
import { CODE_CHALLENGE_METHOD, isValidCodeChallenge } from './pkce.ts';
import { isRegisteredRedirect, redirectHost, validateRedirectUri } from './redirect-uri.ts';
import { enabledScopes, parseScopeParameter, type Scope } from './scopes.ts';

import type { ClientResolver, ResolvedClient } from './clients/resolve.ts';

export interface AuthorizationRequest {
  readonly client: ResolvedClient;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  readonly scopes: readonly Scope[];
  readonly state: string | undefined;
}

/**
 * OAUTH-14: a failure either has a trusted redirect to carry the error, or
 * it does not and must be rendered as a page.
 */
export type AuthorizationFailure =
  | { readonly kind: 'page'; readonly error: OAuthError }
  | {
      readonly kind: 'redirect';
      readonly redirectUri: string;
      readonly state: string | undefined;
      readonly error: OAuthError;
    };

export interface AuthorizationRequestOptions {
  readonly publicUrl: string;
  readonly enableWriteScope: boolean;
  readonly resolver: ClientResolver;
}

function page(error: OAuthError): AuthorizationFailure {
  return { kind: 'page', error };
}

function required(fields: FormFields, name: string): string | undefined {
  const value = fields.get(name);
  return value === undefined || value.length === 0 ? undefined : value;
}

/**
 * Identifies the client and a redirect URI it registered; until both are
 * known nothing may be redirected (T5).
 */
async function trustedRedirect(
  fields: FormFields,
  resolver: ClientResolver,
): Promise<Result<{ client: ResolvedClient; redirectUri: string }, AuthorizationFailure>> {
  const clientId = required(fields, 'client_id');
  const redirectUri = required(fields, 'redirect_uri');
  if (clientId === undefined || redirectUri === undefined) {
    return fail(page(new OAuthError('invalid_request', 'client_id and redirect_uri are required')));
  }
  const validated = validateRedirectUri(redirectUri);
  if (!validated.ok) {
    return fail(page(new OAuthError('invalid_request', validated.error.message)));
  }
  const client = await resolver.resolve(clientId, redirectUri);
  if (!client.ok) {
    return fail(page(client.error));
  }
  if (!isRegisteredRedirect(redirectUri, client.value.redirectUris)) {
    return fail(
      page(new OAuthError('invalid_request', 'redirect_uri is not registered for this client')),
    );
  }
  return ok({ client: client.value, redirectUri });
}

function validateRest(
  fields: FormFields,
  options: AuthorizationRequestOptions,
): Result<Pick<AuthorizationRequest, 'codeChallenge' | 'resource' | 'scopes'>, OAuthError> {
  if (fields.get('response_type') !== 'code') {
    return fail(new OAuthError('unsupported_response_type', 'response_type must be "code"'));
  }
  const codeChallenge = required(fields, 'code_challenge');
  if (codeChallenge === undefined || !isValidCodeChallenge(codeChallenge)) {
    return fail(new OAuthError('invalid_request', 'code_challenge is required (PKCE, S256)'));
  }
  if (fields.get('code_challenge_method') !== CODE_CHALLENGE_METHOD) {
    return fail(new OAuthError('invalid_request', 'code_challenge_method must be "S256"'));
  }
  const resource = required(fields, 'resource');
  if (resource !== canonicalResource(options.publicUrl)) {
    return fail(new OAuthError('invalid_target', 'resource must be the canonical MCP resource'));
  }
  const scopes = parseScopeParameter(fields.get('scope'), enabledScopes(options));
  if (!scopes.ok) {
    return fail(new OAuthError('invalid_scope', scopes.error.message));
  }
  return ok({ codeChallenge, resource, scopes: scopes.value });
}

/**
 * OAUTH-14…16 over the query string of `GET /oauth/authorize`.
 */
export async function parseAuthorizationRequest(
  url: URL,
  options: AuthorizationRequestOptions,
): Promise<Result<AuthorizationRequest, AuthorizationFailure>> {
  const fields = readQuery(url);
  if (!fields.ok) {
    return fail(page(fields.error));
  }
  const trusted = await trustedRedirect(fields.value, options.resolver);
  if (!trusted.ok) {
    return trusted;
  }
  const state = required(fields.value, 'state');
  const rest = validateRest(fields.value, options);
  if (!rest.ok) {
    return fail({ kind: 'redirect', redirectUri: trusted.value.redirectUri, state, error: rest.error });
  }
  return ok({ ...trusted.value, ...rest.value, state });
}

/**
 * What the pending authorization keeps: everything needed to render consent
 * and issue the code without a second client resolution.
 */
export function toPendingParameters(request: AuthorizationRequest): Record<string, string> {
  return {
    client_id: request.client.clientId,
    client_name: request.client.clientName,
    client_mode: request.client.mode,
    loopback_only: request.client.loopbackOnly ? '1' : '0',
    redirect_uri: request.redirectUri,
    redirect_host: redirectHost(request.redirectUri),
    code_challenge: request.codeChallenge,
    resource: request.resource,
    scope: request.scopes.join(' '),
    ...(request.state === undefined ? {} : { state: request.state }),
  };
}
