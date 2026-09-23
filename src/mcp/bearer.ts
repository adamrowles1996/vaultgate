/**
 * Bearer extraction and verification for `/mcp` (OAUTH-31, OAUTH-32). The
 * SDK's `requireBearerAuth` is not used because the challenge strings are a
 * byte-exact contract of this project (spec §03.7) and the verifier speaks
 * `Result` rather than exceptions.
 */
import { enabledScopes, type Scope } from '../scopes/registry.ts';

import {
  invalidTokenChallenge,
  missingTokenChallenge,
  unauthorizedResponse,
} from './challenges.ts';
import { effectiveScopes } from './scopes.ts';

import type { TokenVerifier, VerifiedToken } from '../auth/token-types.ts';
import type { Config } from '../config/index.ts';

export interface BearerVerdict {
  readonly token: VerifiedToken;
  readonly scopes: readonly Scope[];
}

const BEARER_PREFIX = /^bearer\s+(?<token>\S+)$/i;

function bearerToken(header: string): string | undefined {
  return BEARER_PREFIX.exec(header)?.groups?.['token'];
}

export async function authenticate(
  headers: Headers,
  verifier: TokenVerifier,
  config: Pick<Config, 'enableWriteScope' | 'actions'>,
  resourceMetadataUrl: string,
): Promise<BearerVerdict | Response> {
  const header = headers.get('authorization');
  if (header === null) {
    return unauthorizedResponse(
      missingTokenChallenge(resourceMetadataUrl),
      'a bearer token is required',
    );
  }
  const raw = bearerToken(header);
  if (raw === undefined) {
    return unauthorizedResponse(
      invalidTokenChallenge(resourceMetadataUrl),
      'expected "Authorization: Bearer <token>"',
    );
  }
  const verified = await verifier.verify(raw);
  if (!verified.ok) {
    return unauthorizedResponse(invalidTokenChallenge(resourceMetadataUrl), verified.error.message);
  }
  return {
    token: verified.value,
    scopes: effectiveScopes(verified.value.scopes, enabledScopes(config)),
  };
}
