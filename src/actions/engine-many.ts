/**
 * ACT-16 and ACT-110 for a tool that names its targets in `repo`: each name
 * is resolved in the ACT-16 order, stopping at the first failure, and gets
 * its own `action_calls` row and audit event (ACT-60, ACT-116); then every
 * credential is fetched and every destination pinned, and the connector runs
 * the operation over all of them at once. Such tools are read-only, so no
 * confirmation is ever asked for, and a list may not carry the arguments the
 * tool allows with one target only.
 */
import { combineScrubbers } from './combined-scrub.ts';
import { type CallFacts, recordFailure, reserveCall, type Reservation } from './engine-record.ts';
import { type Invocation, resolveCall, type ResolvedCall } from './engine-resolve.ts';
import { runConnectorMany } from './engine-run-many.ts';
import { fetchCredential, pinDestination, type ConnectorCall } from './engine-run.ts';
import { ActionError } from './errors.ts';
import { createRunSupport } from './run-support.ts';

import type { Caller } from './caller.ts';
import type { EngineContext, CallOutcome } from './engine.ts';

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

function withRepo(error: ActionError, repo: string): ActionError {
  return new ActionError(error.code, { ...error.detail, repo });
}

/**
ACT-110: a list of targets may not carry the arguments the tool allows with one only.
*/
function singleOnlyProblem(
  context: EngineContext,
  invocation: Invocation,
  names: readonly string[],
): string | undefined {
  if (names.length < 2) {
    return undefined;
  }
  const tool = context.resolve.connectors
    .forTool(invocation.tool)
    ?.tools.find((candidate) => candidate.name === invocation.tool);
  const found = tool?.repo?.singleOnly.find((key) => invocation.arguments[key] !== undefined);
  return found === undefined ? undefined : `${found} may be given with one repo only`;
}

export async function callMany(
  context: EngineContext,
  caller: Caller,
  invocation: Invocation,
  names: readonly string[],
): Promise<CallOutcome> {
  const problem = singleOnlyProblem(context, invocation, names);
  if (problem !== undefined) {
    const facts = factsFor(context, caller, invocation);
    const error = new ActionError('invalid_arguments', { problem });
    return { kind: 'error', error: recordFailure(context, facts, error) };
  }
  const resolved = resolveAll(context, caller, invocation, names);
  if ('error' in resolved) {
    return { kind: 'error', error: resolved.error };
  }
  const limits = resolved.prepared.map((entry) =>
    context.limits.acquire({
      targetId: entry.resolved.target.row.id,
      clientId: caller.clientId,
      targetPerMinute: entry.resolved.target.documents.common.rate_limit_per_minute,
    }),
  );
  try {
    const refused = limits.findIndex((limit) => !limit.allowed);
    const limited = limits[refused];
    const entry = resolved.prepared[refused];
    if (limited !== undefined && entry !== undefined && !limited.allowed) {
      const error = new ActionError('rate_limited', { retry_after_s: limited.retryAfterSeconds });
      return { kind: 'error', error: recordFailure(context, entry.facts, error) };
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
  // No nonce is ever consumed here (no confirmation), so a reservation cannot be refused.
  const reservations = known.map((facts) => reserveCall(context, facts) as Reservation);
  const scrub = combineScrubbers(calls.map((call) => call.credential.scrub));
  const output = await runConnectorMany(context, calls, scrub);
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
