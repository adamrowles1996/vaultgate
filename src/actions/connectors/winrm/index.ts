/**
 * The `winrm` connector runtime (spec §14.6, M13): the document schemas, the
 * `winrm_run` tool, the pure policy half (ACT-39, ACT-88) and `run` over an
 * injected session factory (ACT-78). `createWinrmConnector` is what the
 * registry builds on a deployment with `VAULTGATE_ACTIONS_ENABLE_WINRM=true`,
 * closing over `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND`; contract tests build one
 * with the same call over a fake WS-Management destination.
 */
import { randomBytes, randomUUID } from 'node:crypto';

import { createPinnedHttpsFetch } from '../../../net/pinned-https.ts';
import { VERSION } from '../../../version.ts';

import { createAuthorize, createCapabilities, describeOperation } from './authorize.ts';
import { winrmSessionOver } from './client.ts';
import { winrmRunTool, type WinrmOperation } from './operation.ts';
import { createRun } from './run.ts';
import {
  winrmSchemas,
  type WinrmCredential,
  type WinrmDestination,
  type WinrmPolicy,
} from './schemas.ts';

import type { WinrmDeployment } from './authorize.ts';
import type { WinrmSessionFactory } from './session.ts';
import type { Connector } from '../connector.ts';

export type WinrmConnector = Connector<
  WinrmDestination,
  WinrmCredential,
  WinrmPolicy,
  WinrmOperation
>;

/**
 * ACT-90: `Signal` and `Delete` run after the call's own deadline may already
 * have elapsed, so they get a short deadline of their own rather than none.
 */
const CLEANUP_TIMEOUT_MS = 10_000;

export function cleanupSignal(): AbortSignal {
  return AbortSignal.timeout(CLEANUP_TIMEOUT_MS);
}

const defaultSession: WinrmSessionFactory = winrmSessionOver({
  transport: createPinnedHttpsFetch(),
  version: VERSION,
  newId: randomUUID,
  cleanupSignal,
  // ACT-89: the NTLM client challenge and exported session key.
  random: randomBytes,
  now: Date.now,
});

export function createWinrmConnector(
  deployment: WinrmDeployment,
  open: WinrmSessionFactory = defaultSession,
): WinrmConnector {
  return {
    ...winrmSchemas,
    tools: [winrmRunTool],
    capabilities: createCapabilities(deployment),
    authorize: createAuthorize(deployment),
    describe: describeOperation,
    run: createRun(open),
  };
}
