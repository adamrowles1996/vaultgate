/**
 * The pure half of the `winrm` connector (ACT-78): the shared command policy
 * of `../command.ts` — the ACT-39 decision, the ACT-43 summary with the
 * ACT-60 classification and the ACT-19 capabilities — bound to the `winrm`
 * documents and the `actions:winrm` scope. No I/O.
 */
import {
  createCommandAuthorize,
  createCommandCapabilities,
  describeCommand,
  type CommandDeployment,
} from '../command.ts';

import type { WinrmOperation } from './operation.ts';
import type { WinrmCredential, WinrmDestination, WinrmPolicy } from './schemas.ts';
import type { PolicyDecision } from '../../policy.ts';
import type { OperationDescription, OperationRequest, TargetCapabilities } from '../connector.ts';

export type WinrmRequest = OperationRequest<WinrmDestination, WinrmCredential, WinrmPolicy>;

export type WinrmDeployment = CommandDeployment;

export function createAuthorize(
  deployment: WinrmDeployment,
): (request: WinrmRequest, operation: WinrmOperation) => PolicyDecision {
  const decide = createCommandAuthorize(deployment);
  return (request, operation) => decide(request.policy, operation);
}

export function describeOperation(
  request: WinrmRequest,
  operation: WinrmOperation,
): OperationDescription {
  return describeCommand(request.policy, operation);
}

export function createCapabilities(
  deployment: WinrmDeployment,
): (destination: WinrmDestination, policy: WinrmPolicy) => TargetCapabilities {
  const capabilities = createCommandCapabilities(deployment, 'actions:winrm');
  return (_destination, policy) => capabilities(policy);
}
