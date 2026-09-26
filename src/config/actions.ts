import { isIP } from 'node:net';

import { z } from 'zod';

import { classifyAddress } from '../net/ip-ranges.ts';

/**
 * The actions layer's switches (spec §13.14). The layer is off unless the
 * master switch is on, and each connector has its own switch; the scope
 * registry and the engine both read this object, never the environment.
 */
export const CONNECTOR_KINDS = ['http', 'sql', 'ssh', 'winrm', 'browser', 'code'] as const;

export type ConnectorKind = (typeof CONNECTOR_KINDS)[number];

export interface ActionsConfig {
  readonly enabled: boolean;
  readonly connectors: Readonly<Record<ConnectorKind, boolean>>;
  /**
  `ws://` or `wss://` DevTools endpoint of the Chromium sidecar; required with the browser connector.
  */
  readonly browserCdpUrl: string | undefined;
  /**
  ACT-113: `http://` URL or `unix:` socket path of the code sidecar; required with the code connector.
  */
  readonly codeUrl: string | undefined;
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
  code: 'VAULTGATE_ACTIONS_ENABLE_CODE',
};

const LOCAL_SIDECAR =
  'must not be a loopback, link-local or other reserved address, or localhost; a local sidecar is reached on a unix: socket';

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

/**
 * Why a code sidecar URL is refused (ACT-113, ACT-114), or `undefined` when
 * it is acceptable: `unix:` and an absolute socket path, or an `http://` URL
 * on a private address or a host name, since the sidecar is reached on an
 * internal network or a local socket, never across the internet. Loopback,
 * link-local and every other forbidden address, and the `localhost` names,
 * are refused too: a sidecar there would share vaultgate's own network
 * namespace with `bw serve`'s unauthenticated loopback (ACT-56), and a
 * local sidecar is reached on a `unix:` socket instead. The URL names the
 * sidecar only: the protocol's paths are fixed, so a path would be ignored.
 */
export function codeUrlProblem(text: string): string | undefined {
  if (text.startsWith('unix:')) {
    const path = text.slice('unix:'.length);
    return path.startsWith('/') && !path.includes('\0')
      ? undefined
      : 'a unix: URL must name an absolute socket path';
  }
  return httpSidecarProblem(text);
}

function httpSidecarProblem(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'must be an http:// URL or unix: and a socket path';
  }
  if (url.protocol !== 'http:' || url.username !== '' || url.password !== '') {
    return 'must be an http:// URL or unix: and a socket path';
  }
  return url.pathname !== '/' || url.search !== '' || url.hash !== ''
    ? 'must name the sidecar itself, with no path, query or fragment'
    : sidecarHostProblem(url.hostname);
}

/**
 * ACT-114: an IP literal must be a private address, and a name must not be
 * `localhost` or under `.localhost` (RFC 6761), which always mean loopback.
 * An address the classifier cannot place (an IPv4-mapped form written in
 * hex) is refused rather than let through as if it were a name.
 */
function sidecarHostProblem(hostname: string): string | undefined {
  const host = literalHost(hostname);
  if (isIP(host) === 0) {
    const name = host.toLowerCase().replace(/\.$/u, '');
    return name === 'localhost' || name.endsWith('.localhost') ? LOCAL_SIDECAR : undefined;
  }
  switch (classifyAddress(host)) {
    case 'private': {
      return undefined;
    }
    case 'public': {
      return 'must not be a public address; the sidecar is reached on an internal network';
    }
    case 'forbidden':
    case 'invalid': {
      return LOCAL_SIDECAR;
    }
  }
}

export const codeUrlSchema: z.ZodType<string | undefined, string | undefined> = z
  .string()
  .transform((text, context) => {
    const problem = codeUrlProblem(text);
    if (problem === undefined) {
      return text;
    }
    context.addIssue({ code: 'custom', message: problem });
    return z.NEVER;
  })
  .optional();

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
