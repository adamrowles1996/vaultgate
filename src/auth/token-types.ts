/**
 * The bearer-token contract between the OAuth authorization server and the
 * MCP resource server (spec §03.7), held once below both features: the
 * resource server only ever sees the verified shape, and the store-backed
 * verifier that produces it lives with the OAuth module.
 */
import type { Result } from '../result.ts';

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

export type TokenVerification = Result<VerifiedToken, TokenRejection>;

export interface TokenVerifier {
  /**
  The store-backed verifier answers synchronously; a promise is accepted so a remote one can implement the same contract.
  */
  verify(token: string): TokenVerification | Promise<TokenVerification>;
}
