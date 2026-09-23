/**
 * `WWW-Authenticate` challenges, byte-exact to spec §03.7 (OAUTH-32, OAUTH-33)
 * and §02.3.1. Parameter order is part of the contract because clients and
 * tests match on the literal string.
 */
import type { Scope } from '../scopes/registry.ts';

const DISCOVERY_SCOPE: Scope = 'vault:read';

/**
No token at all: point the client at the metadata and the scope to start with (§02.3.1).
*/
export function missingTokenChallenge(resourceMetadataUrl: string): string {
  return `Bearer resource_metadata="${resourceMetadataUrl}", scope="${DISCOVERY_SCOPE}"`;
}

/**
OAUTH-32: any verification failure.
*/
export function invalidTokenChallenge(resourceMetadataUrl: string): string {
  return `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}", scope="${DISCOVERY_SCOPE}"`;
}

/**
OAUTH-33: every scope the operation needs, in one challenge.
*/
export function insufficientScopeChallenge(
  resourceMetadataUrl: string,
  scopes: readonly Scope[],
  description: string,
): string {
  return `Bearer error="insufficient_scope", scope="${scopes.join(' ')}", resource_metadata="${resourceMetadataUrl}", error_description="${description}"`;
}

function challengeResponse(
  status: 401 | 403,
  challenge: string,
  body: Record<string, string>,
): Response {
  return Response.json(body, {
    status,
    headers: { 'WWW-Authenticate': challenge, 'Cache-Control': 'no-store' },
  });
}

export function unauthorizedResponse(challenge: string, description: string): Response {
  return challengeResponse(401, challenge, {
    error: 'invalid_token',
    error_description: description,
  });
}

export function forbiddenResponse(
  challenge: string,
  scopes: readonly Scope[],
  description: string,
): Response {
  return challengeResponse(403, challenge, {
    error: 'insufficient_scope',
    scope: scopes.join(' '),
    error_description: description,
  });
}
