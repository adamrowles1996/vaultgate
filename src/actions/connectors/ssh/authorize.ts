/**
 * The pure half of the `ssh` connector (ACT-78): the shared command policy of
 * `../command.ts` — the ACT-39 decision, the ACT-43 summary with the ACT-60
 * classification and the ACT-19 capabilities — bound to the `ssh` documents
 * and the `actions:ssh` scope. No I/O.
 */
import {
  createCommandAuthorize,
  createCommandCapabilities,
  describeCommand,
  type CommandDeployment,
} from '../command.ts';

import type { SshOperation } from './operation.ts';
import type { SshCredential, SshDestination, SshPolicy } from './schemas.ts';
import type { PolicyDecision } from '../../policy.ts';
import type { OperationDescription, OperationRequest, TargetCapabilities } from '../connector.ts';

export type SshRequest = OperationRequest<SshDestination, SshCredential, SshPolicy>;

export type SshDeployment = CommandDeployment;

export function createAuthorize(
  deployment: SshDeployment,
): (request: SshRequest, operation: SshOperation) => PolicyDecision {
  const decide = createCommandAuthorize(deployment);
  return (request, operation) => decide(request.policy, operation);
}

export function describeOperation(
  request: SshRequest,
  operation: SshOperation,
): OperationDescription {
  return describeCommand(request.policy, operation);
}

export function createCapabilities(
  deployment: SshDeployment,
): (destination: SshDestination, policy: SshPolicy) => TargetCapabilities {
  const capabilities = createCommandCapabilities(deployment, 'actions:ssh');
  return (_destination, policy) => capabilities(policy);
}
