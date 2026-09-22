import { createHash } from 'node:crypto';

import { TokenRejection, type TokenVerifier, type VerifiedToken } from '../mcp/token-verifier.ts';
import { fail, ok, type Result } from '../result.ts';

export interface IssueOptions {
  readonly scopes: readonly string[];
  readonly clientId?: string;
  readonly clientName?: string;
  readonly subject?: string;
  readonly expiresAt?: number;
  readonly resource?: string;
}

export interface InMemoryTokenVerifierOptions {
  readonly resource: string;
  readonly now: () => number;
}

const TOKEN_ID_HEX_LENGTH = 12;
const DEFAULT_TTL_MS = 3_600_000;

/**
 * Mints and verifies opaque `vg_at_` tokens in memory, mirroring the checks the
 * store-backed verifier performs (OAUTH-32): prefix, lookup, revocation,
 * expiry and audience.
 */
export class InMemoryTokenVerifier implements TokenVerifier {
  readonly #tokens = new Map<string, VerifiedToken>();
  readonly #revoked = new Set<string>();
  readonly #resource: string;
  readonly #now: () => number;
  #sequence = 0;

  constructor(options: InMemoryTokenVerifierOptions) {
    this.#resource = options.resource;
    this.#now = options.now;
  }

  #verify(token: string): Result<VerifiedToken, TokenRejection> {
    if (!token.startsWith('vg_at_')) {
      return fail(new TokenRejection('malformed', 'not a vaultgate access token'));
    }
    const verified = this.#tokens.get(token);
    if (verified === undefined) {
      return fail(new TokenRejection('unknown', 'unknown token'));
    }
    if (this.#revoked.has(token)) {
      return fail(new TokenRejection('revoked', 'token revoked'));
    }
    if (verified.expiresAt <= this.#now()) {
      return fail(new TokenRejection('expired', 'token expired'));
    }
    return verified.resource === this.#resource
      ? ok(verified)
      : fail(new TokenRejection('unknown', 'token issued for another resource'));
  }

  issue(options: IssueOptions): string {
    this.#sequence += 1;
    const token = `vg_at_test-token-${this.#sequence}`;
    this.#tokens.set(token, {
      tokenId: createHash('sha256').update(token).digest('hex').slice(0, TOKEN_ID_HEX_LENGTH),
      clientId: options.clientId ?? 'https://agent.example/client.json',
      clientName: options.clientName ?? 'Example Agent',
      subject: options.subject ?? 'operator-1',
      scopes: options.scopes,
      expiresAt: options.expiresAt ?? this.#now() + DEFAULT_TTL_MS,
      resource: options.resource ?? this.#resource,
    });
    return token;
  }

  revoke(token: string): void {
    this.#revoked.add(token);
  }

  verify(token: string): Promise<Result<VerifiedToken, TokenRejection>> {
    return Promise.resolve(this.#verify(token));
  }
}
