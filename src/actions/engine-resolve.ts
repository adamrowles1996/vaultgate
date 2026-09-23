/**
 * The first half of ACT-16, in order and stopping at the first failure:
 * layer enabled → target exists → client granted → connector enabled →
 * target enabled → target valid → tool and scope → arguments valid → policy.
 * An ungranted client learns nothing beyond `unknown_target`/`not_granted`;
 * `connector_disabled` comes after the grant check (ACT-67).
 */
import { fail, ok, type Result } from '../result.ts';

import { ActionError } from './errors.ts';
import { validateTarget, type ValidatedTarget, type TargetRow } from './targets-schemas.ts';

import type { AnyConnector, ConnectorTool, OperationDescription } from './connectors/connector.ts';
import type { ConnectorRegistry } from './connectors/registry.ts';
import type { PolicyDecision } from './policy.ts';
import type { TargetsRepo } from './targets-repo.ts';
import type { ActionsConfig } from '../config/actions.ts';

export interface Invocation {
  readonly tool: string;
  /**
  The target name (ACT-1); browser tools resolve a `session_id` instead in M15.
  */
  readonly target: string;
  /**
  The whole tool arguments, `target` included.
  */
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface ResolveDependencies {
  readonly config: Pick<ActionsConfig, 'enabled' | 'connectors'>;
  readonly targets: Pick<TargetsRepo, 'findByName' | 'isGranted'>;
  readonly connectors: ConnectorRegistry;
}

export interface ResolvedCall {
  readonly target: Extract<ValidatedTarget, { state: 'valid' }>;
  readonly connector: AnyConnector;
  readonly tool: ConnectorTool<unknown>;
  /**
  The arguments minus `target`, as the tool's schema parsed them.
  */
  readonly operation: unknown;
  readonly decision: Extract<PolicyDecision, { allowed: true }>;
  readonly description: OperationDescription;
}

export interface Resolution {
  /**
  The row when the name matched, whatever came of the rest; the audit trail names it.
  */
  readonly row: TargetRow | undefined;
  /**
  ACT-26, ACT-60: known as soon as the arguments parse, so a call the policy refuses is
  audited with its classification too, not only the call that ran.
  */
  readonly description: OperationDescription | undefined;
  readonly call: Result<ResolvedCall, ActionError>;
}

type Attempt = Omit<Resolution, 'row'>;

function refused(error: ActionError): Attempt {
  return { description: undefined, call: fail(error) };
}

function resolveOperation(
  scopes: readonly string[],
  invocation: Invocation,
  target: ResolvedCall['target'],
  connector: AnyConnector,
): Attempt {
  const tool = connector.tools.find((candidate) => candidate.name === invocation.tool);
  if (tool === undefined) {
    return refused(
      new ActionError('invalid_arguments', { problem: 'the tool does not apply to this target' }),
    );
  }
  if (!scopes.includes(tool.scope)) {
    return refused(new ActionError('insufficient_scope', { scope: tool.scope }));
  }
  const { target: _name, ...rest } = invocation.arguments;
  const parsed = tool.inputSchema.safeParse(rest);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`,
    );
    return refused(new ActionError('invalid_arguments', { problems: problems.join('; ') }));
  }
  const request = { ...target.documents, tool: tool.name };
  const description = connector.describe(request, parsed.data);
  const decision = connector.authorize(request, parsed.data);
  return {
    description,
    call: decision.allowed
      ? ok({ target, connector, tool, operation: parsed.data, decision, description })
      : fail(new ActionError('policy_denied', { reason: decision.reason })),
  };
}

function resolveGranted(
  dependencies: ResolveDependencies,
  scopes: readonly string[],
  invocation: Invocation,
  row: TargetRow,
): Attempt {
  const connector = dependencies.config.connectors[row.connector]
    ? dependencies.connectors.get(row.connector)
    : undefined;
  if (connector === undefined) {
    return refused(new ActionError('connector_disabled'));
  }
  if (!row.enabled) {
    return refused(new ActionError('target_disabled'));
  }
  const target = validateTarget(row);
  return target.state === 'invalid'
    ? refused(new ActionError('target_invalid'))
    : resolveOperation(scopes, invocation, target, connector);
}

export function resolveCall(
  dependencies: ResolveDependencies,
  caller: { readonly clientId: string; readonly scopes: readonly string[] },
  invocation: Invocation,
): Resolution {
  if (!dependencies.config.enabled) {
    return { row: undefined, ...refused(new ActionError('actions_disabled')) };
  }
  const row = dependencies.targets.findByName(invocation.target);
  if (row === undefined) {
    return { row: undefined, ...refused(new ActionError('unknown_target')) };
  }
  return {
    row,
    ...(dependencies.targets.isGranted(row.id, caller.clientId)
      ? resolveGranted(dependencies, caller.scopes, invocation, row)
      : refused(new ActionError('not_granted'))),
  };
}
