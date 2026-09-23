/**
 * The `ssh` connector runtime (spec §14.5, M12): the document schemas, the
 * `ssh_run` tool, the pure policy half (ACT-39, ACT-88) and `run` over an
 * injected session factory (ACT-78). `createSshConnector` is what the
 * registry builds on a deployment with `VAULTGATE_ACTIONS_ENABLE_SSH=true`,
 * closing over `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND`; contract tests build
 * one with the same call over a fake session.
 */
import { createAuthorize, createCapabilities, describeOperation } from './authorize.ts';
import { sshSession } from './client.ts';
import { sshRunTool, type SshOperation } from './operation.ts';
import { createRun } from './run.ts';
import { sshSchemas, type SshCredential, type SshDestination, type SshPolicy } from './schemas.ts';

import type { SshDeployment } from './authorize.ts';
import type { SshSessionFactory } from './session.ts';
import type { Connector } from '../connector.ts';

export type SshConnector = Connector<SshDestination, SshCredential, SshPolicy, SshOperation>;

export function createSshConnector(
  deployment: SshDeployment,
  open: SshSessionFactory = sshSession,
): SshConnector {
  return {
    ...sshSchemas,
    tools: [sshRunTool],
    capabilities: createCapabilities(deployment),
    authorize: createAuthorize(deployment),
    describe: describeOperation,
    run: createRun(open),
  };
}
