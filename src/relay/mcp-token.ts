/**
 * `POST /mcp/token` (RELAY-14…16): an access token for `/mcp`, issued to an
 * admitted node by the function the composition layer passes in, which mints
 * it under the configured client's live consent (RELAY-11: the relay imports
 * no other feature). The answer carries the token once; the audit event
 * carries only its 12-character prefix.
 */
import { failure, type RelayReply, success } from './responses.ts';

import type { Caller } from './handlers.ts';
import type { AuditSink } from '../audit/event.ts';

/**
What the issuer answers: the client the token belongs to, its prefix, and the body to hand over.
*/
export interface McpTokenGrant {
  readonly clientId: string;
  /**
  First 12 hex characters of the token's SHA-256 (MCP-13); never the token.
  */
  readonly tokenId: string;
  readonly token: object;
}

/**
Issues a token for the caller, or `undefined` when there is no consent to issue under (RELAY-15).
*/
export type IssueMcpToken = (caller: Caller) => McpTokenGrant | undefined;

export const NO_CONSENT = failure(503, 'No consent to issue under.');

export function handleMcpToken(
  dependencies: { readonly audit: AuditSink; readonly issueMcpToken: IssueMcpToken },
  caller: Caller,
): RelayReply {
  const grant = dependencies.issueMcpToken(caller);
  dependencies.audit.record({
    category: 'relay',
    action: 'relay.mcp_token',
    outcome: grant === undefined ? 'failure' : 'ok',
    clientId: grant?.clientId,
    tokenPrefix: grant?.tokenId,
    ip: caller.ip,
    details: {
      node: caller.node,
      ...(grant === undefined && { reason: 'no_consent' }),
    },
  });
  return grant === undefined ? NO_CONSENT : success(grant.token);
}
