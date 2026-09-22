/**
 * The bearer contract the MCP resource server consumes (spec §03.7) is
 * declared in `src/mcp/token-verifier.ts`. This module depends on it as
 * types only, so the two features meet through the interface and never
 * through runtime code (ARCH boundary in `.dependency-cruiser.mjs`).
 */
import type { TokenRejectionReason } from '../mcp/token-verifier.ts';

export type { TokenRejectionReason, TokenVerifier, VerifiedToken } from '../mcp/token-verifier.ts';

/**
 * Structurally identical to the MCP module's `TokenRejection`, so a
 * `Result` carrying it satisfies `TokenVerifier` without importing the class.
 */
export class TokenRejection extends Error {
  readonly reason: TokenRejectionReason;

  constructor(reason: TokenRejectionReason, message: string) {
    super(message);
    this.name = 'TokenRejection';
    this.reason = reason;
  }
}
