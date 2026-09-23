import { TokenRejection, type TokenVerification, type TokenVerifier } from '../auth/token-types.ts';
import { fail, ok, type Result } from '../result.ts';

import { MINUTE_MS, type Clock } from './clock.ts';
import { CREDENTIAL_PREFIX, hasCredentialPrefix, hashCredential } from './credentials.ts';
import { canonicalResource } from './metadata.ts';

import type { ConsentRecord } from './repositories/consents.ts';
import type { OAuthRepos } from './repositories/index.ts';
import type { TokenRecord } from './repositories/tokens.ts';

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
interface LiveToken {
  readonly record: TokenRecord;
  readonly consent: ConsentRecord;
  readonly at: number;
}

function findLiveToken(
  options: StoreTokenVerifierOptions,
  resource: string,
  hash: string,
): Result<LiveToken, TokenRejection> {
  const record = options.repos.tokens.findByHash(hash);
  if (record?.kind !== 'access') {
    return fail(new TokenRejection('unknown', 'unknown token'));
  }
  if (record.revokedAt !== undefined) {
    return fail(new TokenRejection('revoked', 'token revoked'));
  }
  const at = options.now();
  if (record.expiresAt <= at) {
    return fail(new TokenRejection('expired', 'token expired'));
  }
  if (record.resource !== resource) {
    return fail(new TokenRejection('unknown', 'token issued for another resource'));
  }
  const consent = options.repos.consents.findById(record.consentId);
  return consent === undefined || consent.revokedAt !== undefined
    ? fail(new TokenRejection('revoked', 'consent revoked'))
    : ok({ record, consent, at });
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

  verify(token: string): TokenVerification {
    if (!hasCredentialPrefix(token, CREDENTIAL_PREFIX.accessToken)) {
      return fail(new TokenRejection('malformed', 'not a vaultgate access token'));
    }
    const hash = hashCredential(token);
    const live = findLiveToken(this.#options, this.#resource, hash);
    if (!live.ok) {
      return live;
    }
    const { record, consent, at } = live.value;
    const { repos } = this.#options;
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
