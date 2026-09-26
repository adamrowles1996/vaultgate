/**
 * The in-process app with the real `code` connector behind `/mcp`, over the
 * fake GitHub and the fake sidecar of `./code-connector.ts`: the MCP layer's
 * `repo` tools (ACT-110), the handshake instructions (MCP-16) and
 * `actions_list_targets` exercised as a client sees them.
 */
import { createActionsApp, type ActionsApp } from './actions-app.ts';
import {
  CODE_URL,
  codeFakes,
  type CodeHarness,
  type CodeHarnessOptions,
  settleAll,
} from './code-connector.ts';

export interface CodeApp extends ActionsApp {
  readonly code: CodeHarness;
}

export function createCodeApp(options: Omit<CodeHarnessOptions, 'harness'> = {}): CodeApp {
  const fakes = codeFakes(options);
  const app = createActionsApp({
    config: {
      VAULTGATE_ACTIONS_ENABLE_HTTP: 'false',
      VAULTGATE_ACTIONS_ENABLE_CODE: 'true',
      VAULTGATE_ACTIONS_CODE_URL: CODE_URL,
    },
    runtime: fakes.connector,
  });
  const { harness } = app;
  fakes.useClock(() => harness.clock.now());
  const { github, sidecar, connector } = fakes;
  return {
    ...app,
    code: { harness, github, sidecar, connector, settle: () => settleAll(harness) },
  };
}
