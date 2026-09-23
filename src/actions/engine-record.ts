/**
 * What every call leaves behind (ACT-60): the MCP-13 audit event and the
 * `action_calls` row, results never stored (ACT-61). A refused call is one
 * row; a call that reaches the connector reserves its row first (consuming
 * the confirmation nonce, ACT-46) and completes it when it ends.
 */
import { completeCall, type Elicitation, INTERRUPTED_OUTCOME, recordCall } from './calls.ts';
import { ActionError, type ActionOutcome, outcomeOf } from './errors.ts';

import type { Caller } from './caller.ts';
import type { OperationDescription } from './connectors/connector.ts';
import type { Invocation, ResolvedCall } from './engine-resolve.ts';
import type { Scrubber } from './scrub.ts';
import type { TargetRow } from './targets-schemas.ts';
import type { AuditOutcome, AuditSink } from '../audit/event.ts';
import type { DatabaseSync } from 'node:sqlite';

export interface RecordDependencies {
  readonly database: DatabaseSync;
  readonly audit: AuditSink;
  readonly now: () => number;
  readonly newId: () => string;
}

/**
Everything known about a call at the moment it is written down; more of it is known the further it got.
*/
export interface CallFacts {
  readonly caller: Caller;
  readonly invocation: Invocation;
  readonly startedAt: number;
  readonly row: TargetRow | undefined;
  readonly resolved: ResolvedCall | undefined;
  /**
  ACT-26, ACT-60: the operation's summary and classification, known even when the policy refused it.
  */
  readonly description: OperationDescription | undefined;
  /**
  Present once the credential was fetched; arguments are scrubbed with it (ACT-61).
  */
  readonly scrub: Scrubber | undefined;
  readonly elicitation: Elicitation;
  readonly nonce: string | undefined;
}

export interface OutputFacts {
  readonly bytes: number;
  readonly truncated: boolean;
}

/**
How a call ended, as the row records it.
*/
interface Ending {
  readonly outcome: ActionOutcome | typeof INTERRUPTED_OUTCOME;
  readonly output: OutputFacts;
  readonly durationMs: number;
}

const NO_OUTPUT: OutputFacts = { bytes: 0, truncated: false };
const ERROR_PREFIX = 'error:';

/**
MCP-13's outcome: `denied` for every refusal, the code for every failure.
*/
function auditOutcome(outcome: ActionOutcome): AuditOutcome {
  if (outcome === 'ok') {
    return 'ok';
  }
  return outcome.startsWith('denied:') ? 'denied' : `error:${outcome.slice(ERROR_PREFIX.length)}`;
}

function scrubbedArguments(facts: CallFacts): unknown {
  return facts.scrub === undefined
    ? facts.invocation.arguments
    : facts.scrub.deep(facts.invocation.arguments);
}

/**
ACT-61: the classification can be the agent's own text (the command of an any-command `ssh` target).
*/
function scrubbedClassification(facts: CallFacts): string | undefined {
  const classification = facts.description?.classification;
  const scrub = facts.scrub;
  return classification === undefined || scrub === undefined
    ? classification
    : scrub.text(classification);
}

function scrubbedError(facts: CallFacts, error: ActionError): ActionError {
  return facts.scrub === undefined || error.detail === undefined
    ? error
    : new ActionError(error.code, facts.scrub.deep(error.detail));
}

function insertRow(
  dependencies: RecordDependencies,
  facts: CallFacts,
  ending: Ending,
): { readonly id: string; readonly reserved: ActionError | undefined } {
  const id = dependencies.newId();
  const reserved = recordCall(dependencies.database, {
    id,
    at: facts.startedAt,
    targetId: facts.row?.id,
    targetName: facts.invocation.target,
    connector: facts.row?.connector,
    revision: facts.row?.revision,
    tool: facts.invocation.tool,
    sessionIdHash: undefined,
    clientId: facts.caller.clientId,
    tokenPrefix: facts.caller.tokenPrefix,
    operation: facts.resolved?.decision.operation,
    classification: scrubbedClassification(facts),
    arguments: scrubbedArguments(facts),
    outputBytes: ending.output.bytes,
    outputTruncated: ending.output.truncated,
    durationMs: ending.durationMs,
    outcome: ending.outcome,
    elicitation: facts.elicitation,
    confirmationNonce: facts.nonce,
    requestId: facts.caller.requestId,
    ip: facts.caller.ip,
  });
  return { id, reserved: reserved.ok ? undefined : reserved.error };
}

function auditEvent(
  dependencies: RecordDependencies,
  facts: CallFacts,
  outcome: ActionOutcome,
  durationMs: number,
): void {
  dependencies.audit.record({
    category: 'mcp',
    action: facts.invocation.tool,
    outcome: auditOutcome(outcome),
    clientId: facts.caller.clientId,
    tokenPrefix: facts.caller.tokenPrefix,
    requestId: facts.caller.requestId,
    ip: facts.caller.ip,
    durationMs,
    details: {
      clientName: facts.caller.clientName,
      target: facts.invocation.target,
      outcome,
      elicitation: facts.elicitation,
    },
  });
}

/**
 * Writes a refused or failed call as one row and one event and yields the
 * error the agent receives, scrubbed. A confirmation nonce already consumed
 * turns the outcome into `confirmation_reused`.
 */
export function recordFailure(
  dependencies: RecordDependencies,
  facts: CallFacts,
  error: ActionError,
): ActionError {
  const attempted = scrubbedError(facts, error);
  const durationMs = dependencies.now() - facts.startedAt;
  const { reserved } = insertRow(dependencies, facts, {
    outcome: outcomeOf(attempted),
    output: NO_OUTPUT,
    durationMs,
  });
  const final = reserved ?? attempted;
  if (reserved !== undefined) {
    insertRow(
      dependencies,
      { ...facts, nonce: undefined },
      { outcome: outcomeOf(final), output: NO_OUTPUT, durationMs },
    );
  }
  auditEvent(dependencies, facts, outcomeOf(final), durationMs);
  return final;
}

export interface Reservation {
  /**
  Fills in the outcome, output size and duration once the run has ended.
  */
  complete(outcome: ActionOutcome, output: OutputFacts): void;
}

/**
Reserves the row before the connector runs (ACT-46); a consumed nonce refuses the call here.
*/
export function reserveCall(
  dependencies: RecordDependencies,
  facts: CallFacts,
): Reservation | ActionError {
  const { id, reserved } = insertRow(dependencies, facts, {
    outcome: INTERRUPTED_OUTCOME,
    output: NO_OUTPUT,
    durationMs: 0,
  });
  if (reserved !== undefined) {
    return reserved;
  }
  return {
    complete(outcome, output) {
      const durationMs = dependencies.now() - facts.startedAt;
      completeCall(dependencies.database, id, {
        outcome,
        outputBytes: output.bytes,
        outputTruncated: output.truncated,
        durationMs,
      });
      auditEvent(dependencies, facts, outcome, durationMs);
    },
  };
}
