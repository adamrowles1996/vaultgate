import { OAuthError } from './errors.ts';

import type { OAuthAuditSink } from './audit.ts';
import type { OAuthRepos } from './repositories/index.ts';
import type { ClientIpResolver } from './request-context.ts';
import type { TokenIssuerOptions } from './token-issuance.ts';
import type { RateLimiter } from '../net/rate-limit.ts';
import type { ScopeSwitches } from '../scopes/registry.ts';

export interface TokenEndpointDependencies
  extends Omit<TokenIssuerOptions, 'tokens'>, ScopeSwitches {
  readonly publicUrl: string;
  readonly repos: OAuthRepos;
  readonly audit: OAuthAuditSink;
  /**
  60 per minute per ip (OAUTH-28).
  */
  readonly rateLimiter: RateLimiter;
  readonly clientIp: ClientIpResolver;
}

export function invalidGrant(description: string): OAuthError {
  return new OAuthError('invalid_grant', description);
}

export function issuer(dependencies: TokenEndpointDependencies): TokenIssuerOptions {
  return { ...dependencies, tokens: dependencies.repos.tokens };
}

export function isConsentActive(
  dependencies: TokenEndpointDependencies,
  consentId: string,
): boolean {
  const consent = dependencies.repos.consents.findById(consentId);
  return consent !== undefined && consent.revokedAt === undefined;
}
