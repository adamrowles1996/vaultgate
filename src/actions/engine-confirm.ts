/**
 * The confirmation step of ACT-16 (spec §13.8), taken before the credential
 * is fetched so no injected value exists yet: a first call on a confirmed
 * target yields the elicitation request and its `requestState` (ACT-42,
 * ACT-44); a retry carries the answer, which is verified (ACT-45), refused
 * when its nonce is already consumed (ACT-46) and honoured per ACT-47; a
 * client that cannot elicit is refused before anything else (ACT-48).
 */
import { type Elicitation, isNonceConsumed } from './calls.ts';
import {
  argumentsDigest,
  buildConfirmationRequest,
  type ConfirmationBinding,
  type ConfirmationRequest,
  type Confirmations,
  elicitationOutcome,
} from './confirm.ts';
import { ActionError } from './errors.ts';

import type { Caller, ConfirmationInput } from './caller.ts';
import type { Invocation, ResolvedCall } from './engine-resolve.ts';
import type { DatabaseSync } from 'node:sqlite';

export type ConfirmationStep =
  | { readonly kind: 'proceed'; readonly elicitation: Elicitation; readonly nonce?: string }
  | {
      readonly kind: 'request';
      readonly request: ConfirmationRequest;
      readonly requestState: string;
    }
  | { readonly kind: 'refuse'; readonly error: ActionError; readonly elicitation: Elicitation };

export interface ConfirmDependencies {
  readonly database: DatabaseSync;
  readonly confirmations: Confirmations;
}

const REFUSALS: Readonly<Record<'declined' | 'cancelled', ActionError['code']>> = {
  declined: 'confirmation_declined',
  cancelled: 'confirmation_cancelled',
};

/**
The retry: the state must verify against this very call and its nonce must be fresh (ACT-45, ACT-46).
*/
function answeredStep(
  dependencies: ConfirmDependencies,
  answer: ConfirmationInput,
  binding: ConfirmationBinding,
): ConfirmationStep {
  const verified = dependencies.confirmations.verify(answer.requestState, binding);
  if (!verified.ok) {
    return { kind: 'refuse', error: verified.error, elicitation: 'invalid' };
  }
  if (isNonceConsumed(dependencies.database, verified.value.nonce)) {
    return {
      kind: 'refuse',
      error: new ActionError('confirmation_reused'),
      elicitation: 'invalid',
    };
  }
  const outcome = elicitationOutcome(answer.result);
  return outcome === 'accepted'
    ? { kind: 'proceed', elicitation: outcome, nonce: verified.value.nonce }
    : { kind: 'refuse', error: new ActionError(REFUSALS[outcome]), elicitation: outcome };
}

export function confirmationStep(
  dependencies: ConfirmDependencies,
  caller: Caller,
  invocation: Invocation,
  resolved: ResolvedCall,
): ConfirmationStep {
  const { row, documents, schemas } = resolved.target;
  if (!documents.common.confirm_writes || resolved.decision.operation === 'read') {
    return { kind: 'proceed', elicitation: 'not_required' };
  }
  const binding: ConfirmationBinding = {
    target_id: row.id,
    revision: row.revision,
    tool: invocation.tool,
    client_id: caller.clientId,
    token_prefix: caller.tokenPrefix,
    args_sha256: argumentsDigest(invocation.arguments),
  };
  if (caller.confirmation !== undefined) {
    return answeredStep(dependencies, caller.confirmation, binding);
  }
  if (caller.elicitation === 'none') {
    return {
      kind: 'refuse',
      error: new ActionError('confirmation_unavailable'),
      elicitation: 'unavailable',
    };
  }
  const request = buildConfirmationRequest({
    clientName: caller.clientName,
    tool: invocation.tool,
    targetName: row.name,
    connector: row.connector,
    destinationSummary: schemas.summariseDestination(documents.destination),
    operationSummary: resolved.description.summary,
    omitted: resolved.description.omitted,
  });
  return {
    kind: 'request',
    request,
    requestState: dependencies.confirmations.mint(binding).requestState,
  };
}
