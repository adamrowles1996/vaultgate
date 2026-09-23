/**
 * The actions engine (spec §13.6.1, §13.8…§13.12): `call` runs the ACT-16
 * order exactly, one error code per failure and one audit outcome per
 * failure; `listTargets` is ACT-19. The MCP tools and the account pages
 * consume this interface and nothing below it.
 */
import { type ConfirmationRequest, type Confirmations, createConfirmations } from './confirm.ts';
import { confirmationStep } from './engine-confirm.ts';
import { type ListingDependencies, listTargets, type TargetListing } from './engine-listing.ts';
import { type CallFacts, recordFailure, reserveCall } from './engine-record.ts';
import {
  type Invocation,
  resolveCall,
  type ResolveDependencies,
  type ResolvedCall,
} from './engine-resolve.ts';
import { fetchCredential, pinDestination, runConnector } from './engine-run.ts';
import { ActionError } from './errors.ts';
import { type ActionLimits, createActionLimits } from './limits.ts';
import { createRunSupport } from './run-support.ts';
import { createTargetsService, type TargetsService } from './targets.ts';

import type { Caller } from './caller.ts';
import type { ConnectorTool } from './connectors/connector.ts';
import type { ConnectorRegistry } from './connectors/registry.ts';
import type { AuditSink } from '../audit/event.ts';
import type { ActionsConfig, ConnectorKind } from '../config/actions.ts';
import type { Logger } from '../logger.ts';
import type { Lookup } from '../net/ip-ranges.ts';
import type { VaultClient } from '../vault/client.ts';
import type { DatabaseSync } from 'node:sqlite';

export type CallOutcome =
  | { readonly kind: 'ok'; readonly result: Readonly<Record<string, unknown>> }
  | { readonly kind: 'error'; readonly error: ActionError }
  | {
      readonly kind: 'confirmation_required';
      readonly request: ConfirmationRequest;
      readonly requestState: string;
    };

export interface EngineDependencies {
  readonly config: ActionsConfig;
  readonly database: DatabaseSync;
  readonly vault: VaultClient;
  readonly connectors: ConnectorRegistry;
  readonly lookup: Lookup;
  readonly audit: AuditSink;
  readonly logger: Logger;
  readonly secretKey: Buffer;
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
  readonly random: (bytes: number) => Buffer;
  readonly newId: () => string;
}

export interface ActionsEngine {
  /**
  The connectors whose runtime is loaded (ACT-73).
  */
  readonly connectors: readonly ConnectorKind[];
  /**
  The tools those connectors serve, for the MCP layer to register (ACT-15).
  */
  readonly tools: readonly ConnectorTool<unknown>[];
  readonly targets: TargetsService;
  listTargets(caller: Pick<Caller, 'clientId' | 'scopes'>): readonly TargetListing[];
  call(caller: Caller, invocation: Invocation): Promise<CallOutcome>;
}

interface EngineContext extends EngineDependencies {
  readonly confirmations: Confirmations;
  readonly limits: ActionLimits;
  readonly resolve: ListingDependencies & ResolveDependencies;
}

/**
The last steps: credential, pinned destination, the reserved row (ACT-46), the run, the record.
*/
async function execute(
  context: EngineContext,
  facts: CallFacts,
  resolved: ResolvedCall,
): Promise<CallOutcome> {
  const credential = await fetchCredential(context, resolved);
  if (!credential.ok) {
    return { kind: 'error', error: recordFailure(context, facts, credential.error) };
  }
  const known = { ...facts, scrub: credential.value.scrub };
  const pinned = await pinDestination(context.lookup, resolved);
  if (!pinned.ok) {
    credential.value.injected.dispose();
    return { kind: 'error', error: recordFailure(context, known, pinned.error) };
  }
  const reservation = reserveCall(context, known);
  if (reservation instanceof ActionError) {
    credential.value.injected.dispose();
    return {
      kind: 'error',
      error: recordFailure(context, { ...known, nonce: undefined }, reservation),
    };
  }
  const support = createRunSupport(context, resolved.target.row, credential.value);
  const output = await runConnector(context, {
    resolved,
    credential: credential.value,
    pinned: pinned.value,
    support,
  });
  if (!output.ok) {
    const error = new ActionError(
      output.error.code,
      credential.value.scrub.deep(output.error.detail),
    );
    reservation.complete(`error:${error.code}`, { bytes: 0, truncated: false });
    return { kind: 'error', error };
  }
  reservation.complete('ok', {
    bytes: output.value.outputBytes,
    truncated: output.value.outputTruncated,
  });
  return { kind: 'ok', result: output.value.result };
}

async function call(
  context: EngineContext,
  caller: Caller,
  invocation: Invocation,
): Promise<CallOutcome> {
  const resolution = resolveCall(context.resolve, caller, invocation);
  const facts: CallFacts = {
    caller,
    invocation,
    startedAt: context.now(),
    row: resolution.row,
    resolved: resolution.call.ok ? resolution.call.value : undefined,
    scrub: undefined,
    elicitation: 'not_required',
    nonce: undefined,
  };
  if (!resolution.call.ok) {
    return { kind: 'error', error: recordFailure(context, facts, resolution.call.error) };
  }
  const resolved = resolution.call.value;
  const limit = context.limits.acquire({
    targetId: resolved.target.row.id,
    clientId: caller.clientId,
    targetPerMinute: resolved.target.documents.common.rate_limit_per_minute,
  });
  if (!limit.allowed) {
    const error = new ActionError('rate_limited', { retry_after_s: limit.retryAfterSeconds });
    return { kind: 'error', error: recordFailure(context, facts, error) };
  }
  try {
    const step = confirmationStep(context, caller, invocation, resolved);
    if (step.kind === 'request') {
      return {
        kind: 'confirmation_required',
        request: step.request,
        requestState: step.requestState,
      };
    }
    if (step.kind === 'refuse') {
      const refused = { ...facts, elicitation: step.elicitation };
      return { kind: 'error', error: recordFailure(context, refused, step.error) };
    }
    return await execute(
      context,
      { ...facts, elicitation: step.elicitation, nonce: step.nonce },
      resolved,
    );
  } finally {
    limit.release();
  }
}

export function createActionsEngine(dependencies: EngineDependencies): ActionsEngine {
  const { config, connectors, now } = dependencies;
  const targets = createTargetsService({
    database: dependencies.database,
    vault: dependencies.vault,
    lookup: dependencies.lookup,
    audit: dependencies.audit,
    now,
    newId: dependencies.newId,
    allowAnyCommand: config.allowAnyCommand,
  });
  const context: EngineContext = {
    ...dependencies,
    confirmations: createConfirmations({
      secretKey: dependencies.secretKey,
      random: dependencies.random,
      now,
    }),
    limits: createActionLimits(now),
    resolve: { config, targets: targets.repo, connectors },
  };
  return {
    connectors: connectors.kinds,
    tools: connectors.tools,
    targets,
    listTargets: (caller) => listTargets(context.resolve, caller),
    call: (caller, invocation) => call(context, caller, invocation),
  };
}
