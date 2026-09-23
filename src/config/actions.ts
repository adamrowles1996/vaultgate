import { z } from 'zod';

import { classifyAddress } from '../net/ip-ranges.ts';

/**
 * The actions layer's switches (spec §13.14). The layer is off unless the
 * master switch is on, and each connector has its own switch; the scope
 * registry and the engine both read this object, never the environment.
 */
export const CONNECTOR_KINDS = ['http', 'sql', 'ssh', 'winrm', 'browser'] as const;

export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export interface ActionsConfig {
  readonly enabled: boolean;
  readonly connectors: Readonly<Record<ConnectorKind, boolean>>;
  /**
  `ws://` or `wss://` DevTools endpoint of the Chromium sidecar; required with the browser connector.
  */
  readonly browserCdpUrl: string | undefined;
  /**
  Lets `ssh`/`winrm` targets be saved with `any_command: true` (ACT-88).
  */
  readonly allowAnyCommand: boolean;
}

const CONNECTOR_VARIABLES: Readonly<Record<ConnectorKind, string>> = {
  http: 'VAULTGATE_ACTIONS_ENABLE_HTTP',
  sql: 'VAULTGATE_ACTIONS_ENABLE_SQL',
  ssh: 'VAULTGATE_ACTIONS_ENABLE_SSH',
  winrm: 'VAULTGATE_ACTIONS_ENABLE_WINRM',
  browser: 'VAULTGATE_ACTIONS_ENABLE_BROWSER',
};

function literalHost(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/**
Why a CDP URL is refused, or `undefined` when it is acceptable.
*/
export function cdpUrlProblem(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'must be a ws:// or wss:// URL';
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return 'must be a ws:// or wss:// URL';
  }
  return classifyAddress(literalHost(url.hostname)) === 'public'
    ? 'must not be a public address; the sidecar is reached on an internal network'
    : undefined;
}

export const cdpUrlSchema: z.ZodType<string | undefined, string | undefined> = z
  .string()
  .transform((text, context) => {
    const problem = cdpUrlProblem(text);
    if (problem === undefined) {
      return text;
    }
    context.addIssue({ code: 'custom', message: problem });
    return z.NEVER;
  })
  .optional();

/**
 * ACT-67: a connector switch without the master switch does nothing and is
 * reported once at start-up rather than silently ignored.
 */
export function actionsWarnings(actions: ActionsConfig): readonly string[] {
  return actions.enabled
    ? []
    : CONNECTOR_KINDS.filter((kind) => actions.connectors[kind]).map(
        (kind) =>
          `${CONNECTOR_VARIABLES[kind]} is set but VAULTGATE_ENABLE_ACTIONS is false; the ${kind} connector stays off`,
      );
}
