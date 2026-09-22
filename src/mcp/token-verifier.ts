/**
 * The bearer-token contract between the OAuth authorization server and the
 * MCP resource server (spec §03.7). The resource server only ever sees the
 * verified shape below; the store-backed verifier lives with the OAuth
 * module and this file ships a verifier that accepts nothing, used until it
 * is wired.
 */
import { fail, type Result } from '../result.ts';

export interface VerifiedToken {
  /**
  First 12 hex characters of the token's SHA-256 (MCP-13); never the token itself.
  */
  readonly tokenId: string;
  readonly clientId: string;
  readonly clientName: string;
  /**
  The operator who approved the consent.
  */
  readonly subject: string;
  readonly scopes: readonly string[];
  /**
  Milliseconds since the Unix epoch.
  */
  readonly expiresAt: number;
  /**
  The RFC 8707 resource the token was issued for; must equal this deployment's canonical resource.
  */
  readonly resource: string;
}

export type TokenRejectionReason = 'malformed' | 'unknown' | 'revoked' | 'expired';

export class TokenRejection extends Error {
  readonly reason: TokenRejectionReason;

  constructor(reason: TokenRejectionReason, message: string) {
    super(message);
    this.name = 'TokenRejection';
    this.reason = reason;
  }
}

export interface TokenVerifier {
  verify(token: string): Promise<Result<VerifiedToken, TokenRejection>>;
}

/**
 * Accepts no token at all. Wired in `main.ts` until the OAuth authorization
 * server provides the store-backed verifier, so a half-configured deployment
 * fails closed (OAUTH-34).
 */
export class RejectAllTokenVerifier implements TokenVerifier {
  verify(): Promise<Result<VerifiedToken, TokenRejection>> {
    return Promise.resolve(
      fail(new TokenRejection('unknown', 'no authorization server is configured')),
    );
  }
}
