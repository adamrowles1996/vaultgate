/**
 * ACT-16 and ACT-110 for a tool that names its targets in `repo`: each name
 * is resolved in the ACT-16 order, stopping at the first failure, and gets
 * its own `action_calls` row and audit event (ACT-60, ACT-116); the
 * connector judges the targets together (a content type they all allow),
 * then every credential is fetched and every destination pinned, and the
 * connector runs the operation over all of them at once. Such tools are
 * read-only, so no confirmation is ever asked for, and a list may not carry
 * the arguments the tool allows with one target only.
 */
import { combineScrubbers } from './combined-scrub.ts';
import { type CallFacts, recordFailure, reserveCall, type Reservation } from './engine-record.ts';
import { type Invocation, resolveCall, type ResolvedCall } from './engine-resolve.ts';
import { runConnectorMany } from './engine-run-many.ts';
import { fetchCredential, pinDestination, type ConnectorCall } from './engine-run.ts';
import { ActionError } from './errors.ts';
import { createRunSupport } from './run-support.ts';

import type { Caller } from './caller.ts';
import type { RepoArgument } from './connectors/connector.ts';
import type { CallOutcome, EngineContext } from './engine-context.ts';

interface Prepared {
  readonly facts: CallFacts;
  readonly resolved: ResolvedCall;
}

function factsFor(context: EngineContext, caller: Caller, invocation: Invocation): CallFacts {
  return {
    caller,
    invocation,
    startedAt: context.now(),
    row: undefined,
    resolved: undefined,
    description: undefined,
    scrub: undefined,
    elicitation: 'not_required',
    nonce: undefined,
  };
}

/**
The arguments one target is resolved with: `repo` replaced by that one name as `target`.
*/
function perTarget(invocation: Invocation, name: string): Invocation {
  const { repo: _repo, ...rest } = invocation.arguments;
  return { tool: invocation.tool, target: name, arguments: { target: name, ...rest } };
}

function withRepo(error: ActionError, repo: string): ActionError {
  return new ActionError(error.code, { ...error.detail, repo });
}

function resolveAll(
  context: EngineContext,
  caller: Caller,
  invocation: Invocation,
  names: readonly string[],
): { readonly prepared: readonly Prepared[] } | { readonly error: ActionError } {
  const prepared: Prepared[] = [];
  for (const name of names) {
    const audited: Invocation = { ...invocation, target: name };
    const resolution = resolveCall(context.resolve, caller, perTarget(invocation, name));
    const facts: CallFacts = {
      ...factsFor(context, caller, audited),
      row: resolution.row,
      resolved: resolution.call.ok ? resolution.call.value : undefined,
      description: resolution.description,
    };
    if (!resolution.call.ok) {
      return { error: withRepo(recordFailure(context, facts, resolution.call.error), name) };
    }
    if (resolution.call.value.decision.operation !== 'read') {
      const error = new ActionError('connector_fault', { reason: 'multi_target_write' });
      return { error: recordFailure(context, facts, error) };
    }
    prepared.push({ facts, resolved: resolution.call.value });
  }
  return { prepared };
}

/**
The `repo` argument of the tool, when the tool has one.
*/
function repoArgumentOf(context: EngineContext, tool: string): RepoArgument | undefined {
  return context.resolve.connectors
    .forTool(tool)
    ?.tools.find((candidate) => candidate.name === tool)?.repo;
}

/**
ACT-110: one to `max` distinct names, and none of the arguments the tool allows with one only.
*/
function repoProblem(
  context: EngineContext,
  invocation: Invocation,
  names: readonly string[],
): string | undefined {
  const repo = repoArgumentOf(context, invocation.tool);
  const max = repo?.max ?? 1;
  const isDistinct = new Set(names).size === names.length;
  if (!isDistinct || names.length === 0 || names.length > max) {
    return `repo: must name 1 to ${String(max)} distinct connections`;
  }
  const single = names.length > 1 ? repo?.singleOnly : undefined;
  const found = single?.find((key) => invocation.arguments[key] !== undefined);
  return found === undefined ? undefined : `${found}: may be given with one repo only`;
}

/**
 * The connector's decision over every target together (ACT-16's policy step
 * for a list): a refusal is every target's, so each gets its row.
 */
function jointDecision(
  context: EngineContext,
  prepared: readonly Prepared[],
): ActionError | undefined {
  const [head] = prepared as readonly [Prepared];
  const { connector, tool, operation } = head.resolved;
  const requests = prepared.map((entry) => ({
    ...entry.resolved.target.documents,
    tool: tool.name,
  }));
  const decision = connector.authorizeMany?.(requests, operation) ?? head.resolved.decision;
  if (decision.allowed) {
    return undefined;
  }
  const error = new ActionError('policy_denied', { reason: decision.reason });
  for (const entry of prepared) {
    recordFailure(context, entry.facts, error);
  }
  return error;
}

export async function callMany(
  context: EngineContext,
  caller: Caller,
  invocation: Invocation,
  names: readonly string[],
): Promise<CallOutcome> {
  const problem = repoProblem(context, invocation, names);
  if (problem !== undefined) {
    const facts = factsFor(context, caller, invocation);
    const error = new ActionError('invalid_arguments', { problem });
    return { kind: 'error', error: recordFailure(context, facts, error) };
  }
  const resolved = resolveAll(context, caller, invocation, names);
  if ('error' in resolved) {
    return { kind: 'error', error: resolved.error };
  }
  const refused = jointDecision(context, resolved.prepared);
  if (refused !== undefined) {
    return { kind: 'error', error: refused };
  }
  const limits = resolved.prepared.map((entry) =>
    context.limits.acquire({
      targetId: entry.resolved.target.row.id,
      clientId: caller.clientId,
      targetPerMinute: entry.resolved.target.documents.common.rate_limit_per_minute,
    }),
  );
  try {
    const refusedAt = limits.findIndex((limit) => !limit.allowed);
    const limited = limits[refusedAt];
    const entry = resolved.prepared[refusedAt];
    if (limited !== undefined && entry !== undefined && !limited.allowed) {
      const error = new ActionError('rate_limited', { retry_after_s: limited.retryAfterSeconds });
      return {
        kind: 'error',
        error: withRepo(recordFailure(context, entry.facts, error), entry.facts.invocation.target),
      };
    }
    return await executeMany(context, resolved.prepared);
  } finally {
    for (const limit of limits) {
      if (limit.allowed) {
        limit.release();
      }
    }
  }
}

/**
 * The call failed for one target: every target of it gets its row with that
 * error (the call as a whole did not run), and the agent is told which
 * repository failed.
 */
function failAll(
  context: EngineContext,
  facts: readonly CallFacts[],
  failing: number,
  error: ActionError,
): CallOutcome {
  let final = error;
  for (const [index, entry] of facts.entries()) {
    const recorded = recordFailure(context, entry, error);
    if (index === failing) {
      final = withRepo(recorded, entry.invocation.target);
    }
  }
  return { kind: 'error', error: final };
}

async function executeMany(
  context: EngineContext,
  prepared: readonly Prepared[],
): Promise<CallOutcome> {
  const calls: ConnectorCall[] = [];
  const known: CallFacts[] = prepared.map((entry) => entry.facts);
  const disposeAll = (): void => {
    for (const call of calls) {
      call.credential.injected.dispose();
    }
  };
  for (const [index, { facts, resolved }] of prepared.entries()) {
    const credential = await fetchCredential(context, resolved);
    if (!credential.ok) {
      disposeAll();
      return failAll(context, known, index, credential.error);
    }
    known[index] = { ...facts, scrub: credential.value.scrub };
    const pinned = await pinDestination(context.lookup, resolved);
    if (!pinned.ok) {
      credential.value.injected.dispose();
      disposeAll();
      return failAll(context, known, index, pinned.error);
    }
    const support = createRunSupport(context, resolved.target.row, credential.value);
    calls.push({ resolved, credential: credential.value, pinned: pinned.value, support });
  }
  // `callMany` refused an empty list, so there is at least one call; no nonce
  // is ever consumed here (no confirmation), so a reservation cannot be refused.
  const [head, ...rest] = calls as [ConnectorCall, ...ConnectorCall[]];
  const reservations = known.map((facts) => reserveCall(context, facts) as Reservation);
  const scrub = combineScrubbers(
    head.credential.scrub,
    rest.map((call) => call.credential.scrub),
  );
  const output = await runConnectorMany(context, [head, ...rest], scrub);
  if (!output.ok) {
    const error = new ActionError(output.error.code, scrub.deep(output.error.detail));
    for (const reservation of reservations) {
      reservation.complete(`error:${error.code}`, { bytes: 0, truncated: false });
    }
    return { kind: 'error', error };
  }
  for (const reservation of reservations) {
    reservation.complete('ok', {
      bytes: output.value.outputBytes,
      truncated: output.value.outputTruncated,
    });
  }
  return { kind: 'ok', result: output.value.result };
}
