import { isIP } from 'node:net';

/**
 * How the client address is read behind a proxy (OPS-6).
 */
export interface ClientIpOptions {
  /**
  Honour `X-Forwarded-For` at all; off means the socket address is the client.
  */
  readonly trustProxy: boolean;
  /**
  How many trusted proxies append to `X-Forwarded-For`; the entry that many
  from the right is the client, everything left of it is attacker-writable.
  */
  readonly trustedProxyHops: number;
}

export interface ClientIpSource {
  readonly forwardedFor: string | null | undefined;
  readonly socketAddress: string | undefined;
}

/**
 * The client address: the socket's unless a trusted proxy is configured, in
 * which case the `X-Forwarded-For` entry `trustedProxyHops` from the right,
 * provided it is an IP literal. Anything the client could have written
 * (entries further left, a malformed entry, a missing header) never counts;
 * the socket address is the fallback.
 */
export function resolveClientIp(
  source: ClientIpSource,
  options: ClientIpOptions,
): string | undefined {
  if (!options.trustProxy || source.forwardedFor == null) {
    return source.socketAddress;
  }
  const entries = source.forwardedFor.split(',').map((entry) => entry.trim());
  const candidate = entries.at(-options.trustedProxyHops);
  return candidate !== undefined && isIP(candidate) !== 0 ? candidate : source.socketAddress;
}
