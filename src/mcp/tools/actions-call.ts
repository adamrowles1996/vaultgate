/**
 * The transport half of an actions call (spec §13.6.1): who is calling,
 * assembled from the verified token and the request, and how the engine's
 * outcome goes back on the wire: a result or an ACT-15 failure. vaultgate
 * asks no one to approve a call; a client that wants a person to approve
 * writes does so itself, before the call, from the tool annotations (ACT-18).
 */
import { callerTagOf } from '../../actions/caller-tag.ts';

import { failureResult } from './definition.ts';

import type { Caller } from '../../actions/caller.ts';
import type { CallOutcome } from '../../actions/engine.ts';
import type { VerifiedToken } from '../../auth/token-types.ts';
import type { Scope } from '../../scopes/registry.ts';
import type { CallToolResult } from '@modelcontextprotocol/server';

/**
What the route knows about the request before any tool runs.
*/
export interface ActionsCallContext {
  readonly token: VerifiedToken;
  readonly scopes: readonly Scope[];
  readonly requestId: string;
  readonly sourceIp: string;
  /**
  ACT-131: the request's `Mcp-Session-Id` header, if the client sent one; only its hash goes further.
  */
  readonly mcpSessionId?: string | undefined;
}

export function callerFor(context: ActionsCallContext): Caller {
  return {
    clientId: context.token.clientId,
    clientName: context.token.clientName,
    tokenPrefix: context.token.tokenId,
    scopes: context.scopes,
    requestId: context.requestId,
    ip: context.sourceIp,
    tag: callerTagOf({
      clientName: context.token.clientName,
      operatorId: context.token.subject,
      tokenId: context.token.tokenId,
      mcpSessionId: context.mcpSessionId,
      relayNode: context.token.relayNode,
    }),
  };
}

/**
The engine's outcome on the wire: `structuredContent` plus the same JSON as text, or the ACT-15 failure with `isError`.
*/
export function toActionResult(outcome: CallOutcome): CallToolResult {
  if (outcome.kind === 'ok') {
    return {
      content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
      structuredContent: outcome.result,
    };
  }
  const { code, message, detail } = outcome.error;
  return failureResult(code, message, detail);
}
