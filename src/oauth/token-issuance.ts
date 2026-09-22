import { type Clock, toSeconds } from './clock.ts';
import {
  CREDENTIAL_PREFIX,
  hashCredential,
  mintCredential,
  type RandomSource,
} from './credentials.ts';

import type { TokensRepo } from './repositories/tokens.ts';

export interface TokenIssuerOptions {
  readonly tokens: TokensRepo;
  readonly now: Clock;
  readonly random: RandomSource;
  readonly newId: () => string;
  readonly accessTokenTtlMs: number;
  readonly refreshTokenTtlMs: number;
}

export interface Grant {
  readonly clientId: string;
  readonly consentId: string;
  readonly familyId: string;
  readonly parentId: string | undefined;
  readonly scopes: readonly string[];
  readonly resource: string;
  /**
  Carried forward on refresh so the family keeps its absolute lifetime (OAUTH-24).
  */
  readonly refreshExpiresAt: number | undefined;
}

/**
 * OAUTH-26 body.
 */
interface TokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer';
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
  readonly resource: string;
}

export interface IssuedPair {
  readonly clientId: string;
  readonly response: TokenResponse;
  readonly accessTokenId: string;
  readonly refreshTokenId: string;
}

/**
 * OAUTH-24: opaque `vg_at_` and `vg_rt_` tokens, only their hashes stored.
 * Both rows are written by the caller's transaction.
 */
export function issueTokenPair(options: TokenIssuerOptions, grant: Grant): IssuedPair {
  const at = options.now();
  const accessToken = mintCredential(CREDENTIAL_PREFIX.accessToken, options.random);
  const refreshToken = mintCredential(CREDENTIAL_PREFIX.refreshToken, options.random);
  const accessTokenId = options.newId();
  const refreshTokenId = options.newId();
  const accessExpiresAt = at + options.accessTokenTtlMs;
  const shared = {
    familyId: grant.familyId,
    parentId: grant.parentId,
    replacedById: undefined,
    clientId: grant.clientId,
    consentId: grant.consentId,
    scopes: grant.scopes,
    resource: grant.resource,
    issuedAt: at,
    revokedAt: undefined,
    lastUsedAt: undefined,
  };
  options.tokens.insert({
    ...shared,
    id: accessTokenId,
    tokenHash: hashCredential(accessToken),
    kind: 'access',
    expiresAt: accessExpiresAt,
  });
  options.tokens.insert({
    ...shared,
    id: refreshTokenId,
    tokenHash: hashCredential(refreshToken),
    kind: 'refresh',
    expiresAt: grant.refreshExpiresAt ?? at + options.refreshTokenTtlMs,
  });
  return {
    clientId: grant.clientId,
    accessTokenId,
    refreshTokenId,
    response: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: toSeconds(accessExpiresAt - at),
      refresh_token: refreshToken,
      scope: grant.scopes.join(' '),
      resource: grant.resource,
    },
  };
}
