import { fail, ok, type Result } from '../result.ts';

import { MINUTE_MS, type Clock } from './clock.ts';
import { CREDENTIAL_PREFIX, hasCredentialPrefix, hashCredential } from './credentials.ts';
import { canonicalResource } from './metadata.ts';
import { TokenRejection, type TokenVerifier, type VerifiedToken } from './verified-token.ts';

import type { OAuthRepos } from './repositories/index.ts';

const TOKEN_ID_LENGTH = 12;

/**
 * OAUTH-35: `last_used_at` moves at most once a minute per token.
 */
const LAST_USED_GRANULARITY_MS = MINUTE_MS;

export interface StoreTokenVerifierOptions {
  readonly publicUrl: string;
  readonly repos: Pick<OAuthRepos, 'tokens' | 'clients' | 'consents'>;
  readonly now: Clock;
}

/**
 * OAUTH-32 and OAUTH-34: only an access token vaultgate minted, found by its
 * hash, unrevoked, unexpired and bound to this deployment's resource, is
 * accepted. Nothing else (JWTs, upstream tokens) can pass the prefix check.
 */
export class StoreTokenVerifier implements TokenVerifier {
  readonly #options: StoreTokenVerifierOptions;
  readonly #resource: string;

  constructor(options: StoreTokenVerifierOptions) {
    this.#options = options;
    this.#resource = canonicalResource(options.publicUrl);
  }

  verify(token: string): Promise<Result<VerifiedToken, TokenRejection>> {
    return Promise.resolve(this.#verify(token));
  }

  #verify(token: string): Result<VerifiedToken, TokenRejection> {
    if (!hasCredentialPrefix(token, CREDENTIAL_PREFIX.accessToken)) {
      return fail(new TokenRejection('malformed', 'not a vaultgate access token'));
    }
    const { repos, now } = this.#options;
    const hash = hashCredential(token);
    const record = repos.tokens.findByHash(hash);
    if (record === undefined || record.kind !== 'access') {
      return fail(new TokenRejection('unknown', 'unknown token'));
    }
    if (record.revokedAt !== undefined) {
      return fail(new TokenRejection('revoked', 'token revoked'));
    }
    const at = now();
    if (record.expiresAt <= at) {
      return fail(new TokenRejection('expired', 'token expired'));
    }
    if (record.resource !== this.#resource) {
      return fail(new TokenRejection('unknown', 'token issued for another resource'));
    }
    const consent = repos.consents.findById(record.consentId);
    if (consent === undefined || consent.revokedAt !== undefined) {
      return fail(new TokenRejection('revoked', 'consent revoked'));
    }
    if (record.lastUsedAt === undefined || at - record.lastUsedAt >= LAST_USED_GRANULARITY_MS) {
      repos.tokens.touchLastUsed(record.id, at);
    }
    return ok({
      tokenId: hash.slice(0, TOKEN_ID_LENGTH),
      clientId: record.clientId,
      clientName: repos.clients.findByClientId(record.clientId)?.clientName ?? record.clientId,
      subject: consent.operatorId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: this.#resource,
    });
  }
}
