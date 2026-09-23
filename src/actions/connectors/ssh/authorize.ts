/**
 * The pure half of the `ssh` connector (ACT-78): the policy decision of
 * ACT-39 over an `ssh_run` — every call is a `shell` operation (ACT-40), so
 * `confirm_writes` applies to all of them — the ACT-43 summary with the
 * ACT-60 classification, and the ACT-19 capabilities. The deployment's
 * `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND` is closed over, because §13.14 says
 * turning it off makes an any-command target refuse every call rather than
 * quietly keep working. No I/O.
 */
import { isPatternMatch } from '../../policy.ts';

import { MAX_COMMAND_BYTES, type SshOperation } from './operation.ts';

import type { SshCredential, SshDestination, SshPolicy } from './schemas.ts';
import type { PolicyReason, PolicyDecision } from '../../policy.ts';
import type { OperationDescription, OperationRequest, TargetCapabilities } from '../connector.ts';

const SUMMARY_CAP = 1024;

const LINE_BREAK = /[\n\r]/u;

export type SshRequest = OperationRequest<SshDestination, SshCredential, SshPolicy>;

export interface SshDeployment {
  /**
  ACT-88: `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND`, read once when the connector is loaded.
  */
  readonly allowAnyCommand: boolean;
}

/**
 * ACT-39: `command_size` for a command beyond the 16 KiB of ACT-27 (the
 * tool's own schema refuses one too, so this is the second of two locks),
 * `command` for a line break the target does not allow and for a command no
 * pattern matches.
 */
function refusal(
  policy: SshPolicy,
  command: string,
  deployment: SshDeployment,
): PolicyReason | undefined {
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
    return 'command_size';
  }
  if (policy.any_command) {
    return deployment.allowAnyCommand ? undefined : 'command';
  }
  if (LINE_BREAK.test(command)) {
    return 'command';
  }
  return policy.allowed_commands.some((pattern) => isPatternMatch(pattern, command, 'command'))
    ? undefined
    : 'command';
}

export function createAuthorize(
  deployment: SshDeployment,
): (request: SshRequest, operation: SshOperation) => PolicyDecision {
  return (request, operation) => {
    const reason = refusal(request.policy, operation.command, deployment);
    return reason === undefined
      ? { allowed: true, operation: 'shell' }
      : { allowed: false, reason };
  };
}

/**
 * ACT-43: the command as the agent wrote it, capped. ACT-60: the class the
 * engine audits is the word `command`, except on an any-command target,
 * where ACT-88 wants the whole command recorded and the 4 KiB cap on
 * `arguments` could cut it. The engine scrubs both (ACT-61).
 */
export function describeOperation(
  request: SshRequest,
  operation: SshOperation,
): OperationDescription {
  return {
    summary: operation.command.slice(0, SUMMARY_CAP),
    classification: request.policy.any_command ? operation.command : 'command',
  };
}

/**
 * ACT-19, ACT-88: an `ssh` target offers the one `shell` operation and says
 * when it is unrestricted. An any-command target on a deployment that no
 * longer allows one offers nothing, so agents stop seeing it the moment the
 * switch goes off (§13.14).
 */
export function createCapabilities(
  deployment: SshDeployment,
): (destination: SshDestination, policy: SshPolicy) => TargetCapabilities {
  return (_destination, policy) => {
    const isRefused = policy.any_command && !deployment.allowAnyCommand;
    return {
      operations: isRefused ? [] : [{ operation: 'shell', scope: 'actions:ssh' }],
      ...(policy.any_command && { unrestricted: true }),
    };
  };
}
