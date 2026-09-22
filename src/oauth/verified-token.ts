import type { Result } from '../result.ts';

/**
 * The bearer contract the MCP resource server consumes (spec §03.7). It is
 * structurally identical to `src/mcp/token-verifier.ts`; the OAuth module
 * declares it so the two features depend on the shape, not on each other.
 */
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
