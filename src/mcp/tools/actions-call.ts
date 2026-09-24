/**
 * The transport half of an actions call (spec §13.6.1, §13.8): who is
 * calling, assembled from the verified token and the request (ACT-48's
 * capability, ACT-45's retried answer), and how the engine's outcome goes
 * back on the wire: a result, an ACT-15 failure, or the ACT-42 elicitation
 * request as the SDK's `InputRequiredResult`.
 */
import {
  type CallToolResult,
  CLIENT_CAPABILITIES_META_KEY,
  type InputRequest,
  inputRequired,
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

import { failureResult } from './definition.ts';

import type { Caller, ConfirmationInput } from '../../actions/caller.ts';
import type { ConfirmationRequest, ElicitResult } from '../../actions/confirm.ts';
import type { CallOutcome } from '../../actions/engine.ts';
import type { VerifiedToken } from '../../auth/token-types.ts';
import type { Scope } from '../../scopes/registry.ts';

/**
What the route knows about the request before any tool runs.
*/
export interface ActionsCallContext {
  readonly token: VerifiedToken;
  readonly scopes: readonly Scope[];
  readonly requestId: string;
  readonly sourceIp: string;
  readonly elicitation: Caller['elicitation'];
}

const capabilitiesMetaSchema = z.object({
  [CLIENT_CAPABILITIES_META_KEY]: z.record(z.string(), z.unknown()),
});
const clientCapabilitiesSchema = z.object({
  params: z.object({ _meta: capabilitiesMetaSchema }).optional(),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * ACT-48: the client's elicitation support, read from the 2026-07-28
 * per-request envelope: an `elicitation` object that names `form` or is
 * empty means form mode; anything else, including a request without the
 * envelope, cannot elicit.
 *
 * A request on the 2025 wire therefore always answers `none`, and that is
 * final rather than provisional. That wire declares elicitation once, in
 * `initialize`, and MCP-1's stateless handler builds a fresh server per HTTP
 * request that never sees that message: the SDK resolves the capability view
 * from `initialize` on a legacy-era instance and a per-request instance holds
 * nothing, so its own legacy shim refuses with "no client capabilities are
 * available on this connection — per-request legacy serving cannot receive
 * server-to-client requests". Attempting the fallback anyway costs the agent
 * its typed `confirmation_unavailable` code and the operator the ACT-60 row,
 * and still shows no human a prompt; `actions-elicitation.test.ts` pins what
 * a real 2025-wire SDK client actually gets. Spec ACT-48 records why.
 */
export function elicitationCapability(body: unknown): Caller['elicitation'] {
  const parsed = clientCapabilitiesSchema.safeParse(body);
  const declared = parsed.success
    ? parsed.data.params?._meta[CLIENT_CAPABILITIES_META_KEY]['elicitation']
    : undefined;
  if (!isPlainObject(declared)) {
    return 'none';
  }
  return 'form' in declared || Object.keys(declared).length === 0 ? 'form' : 'none';
}

const elicitResultSchema = z.looseObject({
  action: z.enum(['accept', 'decline', 'cancel']),
  content: z.record(z.string(), z.unknown()).optional(),
});

function toElicitResult(answer: z.output<typeof elicitResultSchema>): ElicitResult {
  return answer.action === 'accept'
    ? { action: 'accept', content: answer.content }
    : { action: answer.action };
}

/**
 * ACT-45: the retried call carries the echoed `requestState` and the
 * client's `confirm` answer. A retry that carries the state but no
 * well-formed answer is treated as a fresh call: nothing runs, the engine
 * asks again, and the unanswered state simply expires.
 */
function confirmationInput(context: ServerContext): ConfirmationInput | undefined {
  const requestState = context.mcpReq.requestState();
  if (typeof requestState !== 'string') {
    return undefined;
  }
  const answer = elicitResultSchema.safeParse(context.mcpReq.inputResponses?.['confirm']);
  return answer.success ? { requestState, result: toElicitResult(answer.data) } : undefined;
}

export function callerFor(context: ActionsCallContext, serverContext: ServerContext): Caller {
  const confirmation = confirmationInput(serverContext);
  return {
    clientId: context.token.clientId,
    clientName: context.token.clientName,
    tokenPrefix: context.token.tokenId,
    scopes: context.scopes,
    requestId: context.requestId,
    ip: context.sourceIp,
    elicitation: context.elicitation,
    ...(confirmation !== undefined && { confirmation }),
  };
}

/**
ACT-42, verbatim, in the mutable shape the SDK's wire type asks for.
*/
function toInputRequest(request: ConfirmationRequest): InputRequest {
  const { requestedSchema, ...parameters } = request.params;
  return {
    method: request.method,
    params: {
      ...parameters,
      requestedSchema: { ...requestedSchema, required: [...requestedSchema.required] },
    },
  };
}

/**
 * The engine's outcome on the wire: `structuredContent` plus the same JSON
 * as text, the ACT-15 failure with `isError`, or the ACT-42 document as the
 * SDK's multi-round-trip result with the engine's `requestState`.
 */
export function toActionResult(outcome: CallOutcome): CallToolResult | InputRequiredResult {
  switch (outcome.kind) {
    case 'ok': {
      return {
        content: [{ type: 'text', text: JSON.stringify(outcome.result) }],
        structuredContent: outcome.result,
      };
    }
    case 'error': {
      const { code, message, detail } = outcome.error;
      return failureResult(code, message, detail);
    }
    case 'confirmation_required': {
      return inputRequired({
        inputRequests: { confirm: toInputRequest(outcome.request) },
        requestState: outcome.requestState,
      });
    }
  }
}
