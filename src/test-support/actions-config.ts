import type { ActionsConfig, ConnectorKind } from '../config/actions.ts';

/**
The actions layer as every deployment starts: off, every connector off.
*/
export const ACTIONS_OFF: ActionsConfig = {
  enabled: false,
  connectors: { http: false, sql: false, ssh: false, winrm: false, browser: false },
  browserCdpUrl: undefined,
  allowAnyCommand: false,
};

/**
The layer on with the named connectors on; everything else stays off.
*/
export function actionsEnabled(
  kinds: readonly ConnectorKind[],
  overrides: Partial<Pick<ActionsConfig, 'allowAnyCommand' | 'browserCdpUrl'>> = {},
): ActionsConfig {
  return {
    ...ACTIONS_OFF,
    ...overrides,
    enabled: true,
    connectors: {
      ...ACTIONS_OFF.connectors,
      ...Object.fromEntries(kinds.map((kind) => [kind, true])),
    },
  };
}
