import { isIP } from 'node:net';

import { z } from 'zod';

/**
 * The credential relay's settings (spec §15.2). The relay is off unless a
 * listen address is set (RELAY-1); the schema, not the relay, refuses a
 * wildcard bind and a malformed tag or id, so a bad value stops start-up.
 */
export interface RelayListen {
  /**
  An IP literal: the tailnet address the relay alone listens on (RELAY-2).
  */
  readonly host: string;
  readonly port: number;
}

export interface RelayConfig {
  /**
  Where the relay listens; `undefined` means it is off.
  */
  readonly listen: RelayListen | undefined;
  /**
  Tailscale tags, at least one of which a caller's node must carry (RELAY-3).
  */
  readonly tags: readonly string[];
  /**
  Collection ids whose items the relay may answer (RELAY-4).
  */
  readonly collections: readonly string[];
  /**
  Item ids the relay may answer, besides those in `collections` (RELAY-4).
  */
  readonly items: readonly string[];
  /**
  The local Tailscale daemon's LocalAPI socket, asked who each caller is.
  */
  readonly tailscaleSocket: string;
}

export const DEFAULT_TAILSCALE_SOCKET = '/var/run/tailscale/tailscaled.sock';

const MIN_PORT = 1;
const MAX_PORT = 65_535;
const UNSPECIFIED = new Set(['0.0.0.0', '::']);
const TAG = /^tag:[a-z0-9][a-z0-9-]*$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PORT = /^\d{1,5}$/;
const SHAPE = 'must be an IP address and a port, such as 100.64.0.10:8087';

/**
`host:port` or `[v6]:port` as a listen address, or why it is refused.
*/
export function parseRelayListen(text: string): RelayListen | string {
  const trimmed = text.trim();
  const separator = trimmed.lastIndexOf(':');
  const portText = trimmed.slice(separator + 1);
  if (separator === -1 || !PORT.test(portText)) {
    return SHAPE;
  }
  const hostPart = trimmed.slice(0, separator);
  const isBracketed = hostPart.startsWith('[') && hostPart.endsWith(']');
  const host = isBracketed ? hostPart.slice(1, -1) : hostPart;
  const family = isIP(host);
  if (family === 0) {
    return 'must name an IP address, not a host name';
  }
  if ((family === 6) !== isBracketed) {
    return 'must write an IPv6 address, and only an IPv6 address, in brackets';
  }
  if (UNSPECIFIED.has(host)) {
    return 'must name one address; a wildcard would listen on every network';
  }
  const port = Number(portText);
  return port < MIN_PORT || port > MAX_PORT
    ? `must use a port from ${String(MIN_PORT)} to ${String(MAX_PORT)}`
    : { host, port };
}

export const relayListenSchema: z.ZodType<RelayListen | undefined, string | undefined> = z
  .string()
  .optional()
  .transform((text, context) => {
    if (text === undefined) {
      return;
    }
    const parsed = parseRelayListen(text);
    if (typeof parsed === 'string') {
      context.addIssue({ code: 'custom', message: parsed });
      return z.NEVER;
    }
    return parsed;
  });

/**
A comma-separated list whose every entry must match `pattern`; empty entries are skipped.
*/
function listSchema(
  pattern: RegExp,
  example: string,
): z.ZodType<readonly string[], string | undefined> {
  return z
    .string()
    .default('')
    .transform((text, context) => {
      const entries = text
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
      const wrong = entries.find((entry) => !pattern.test(entry));
      if (wrong !== undefined) {
        context.addIssue({ code: 'custom', message: `"${wrong}" is not ${example}` });
        return z.NEVER;
      }
      return [...new Set(entries.map((entry) => entry.toLowerCase()))];
    });
}

export const relayTagsSchema = listSchema(TAG, 'a Tailscale tag such as tag:servers');

export const relayIdsSchema = listSchema(UUID, 'a vault id (a UUID)');
