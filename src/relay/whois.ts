/**
 * Who a relay caller is (RELAY-3): the local Tailscale daemon's LocalAPI
 * `whois` names the tailnet node behind a peer address, its tags, its own
 * addresses and whether it routes for anyone else. The daemon is the
 * authority because it holds the tailnet's key for every peer: an address
 * it does not map to a node is not a tailnet peer at all. Any failure, a
 * slow answer or a shape this module does not recognise resolves to no
 * peer, so the caller is refused rather than guessed at.
 */
import { z } from 'zod';

import type { LocalHttp } from '../net/local-http.ts';

export interface TailnetPeer {
  /**
  The node's MagicDNS name without the trailing dot; it carries the machine name.
  */
  readonly node: string;
  /**
  The node's tags, lower-cased; empty for a node a user owns.
  */
  readonly tags: readonly string[];
  /**
  The node's own tailnet addresses, lower-cased and without prefix lengths.
  */
  readonly addresses: readonly string[];
  /**
  Whether the node routes for other addresses: a subnet router or an exit node.
  */
  readonly routes: boolean;
}

/**
Why an identified peer is still refused (RELAY-3).
*/
export type AdmissionProblem = 'untagged' | 'router' | 'address';

export type WhoIs = (address: string) => Promise<TailnetPeer | undefined>;

/**
The `Host` the LocalAPI requires of every request over its socket.
*/
const LOCALAPI_HOST = 'local-tailscaled.sock';
const WHOIS_TIMEOUT_MS = 2000;
const MAX_WHOIS_BYTES = 256 * 1024;

const nodeSchema = z.object({
  Name: z.string().min(1),
  Tags: z.array(z.string()).nullish(),
  Addresses: z.array(z.string()).min(1),
  AllowedIPs: z.array(z.string()).nullish(),
  PrimaryRoutes: z.array(z.string()).nullish(),
});

function withoutLength(prefix: string): string {
  return prefix.replace(/\/\d+$/, '').toLowerCase();
}

const whoIsSchema = z.object({ Node: nodeSchema });

function parsePeer(body: Buffer): TailnetPeer | undefined {
  let document: unknown;
  try {
    document = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  const parsed = whoIsSchema.safeParse(document);
  if (!parsed.success) {
    return undefined;
  }
  const { Name, Tags, Addresses, AllowedIPs, PrimaryRoutes } = parsed.data.Node;
  const own = new Set(Addresses.map((prefix) => prefix.toLowerCase()));
  const isRoutingOthers = (AllowedIPs ?? []).some((prefix) => !own.has(prefix.toLowerCase()));
  return {
    node: Name.replace(/\.$/, ''),
    tags: (Tags ?? []).map((tag) => tag.toLowerCase()),
    addresses: Addresses.map((prefix) => withoutLength(prefix)),
    routes: isRoutingOthers || (PrimaryRoutes ?? []).length > 0,
  };
}

/**
`whois` over the LocalAPI socket `http` reaches; `timeoutMs` bounds each question.
*/
export function createWhoIs(http: LocalHttp, timeoutMs: number = WHOIS_TIMEOUT_MS): WhoIs {
  return async (address) => {
    try {
      const response = await http({
        method: 'GET',
        path: `/localapi/v0/whois?addr=${encodeURIComponent(address)}`,
        headers: { host: LOCALAPI_HOST },
        signal: AbortSignal.timeout(timeoutMs),
        maxResponseBytes: MAX_WHOIS_BYTES,
      });
      return response.status === 200 ? parsePeer(response.body) : undefined;
    } catch {
      return;
    }
  };
}

/**
 * RELAY-3: why `peer`, the node behind `address`, is refused, or `undefined`
 * when it is admitted. It must carry one of `tags`; it must not route for
 * other addresses, because traffic a subnet router or exit node forwards
 * reaches the relay under the router's own identity; and `address` must be
 * one of its own, not an address behind it.
 */
export function admissionProblem(
  peer: TailnetPeer,
  tags: readonly string[],
  address: string,
): AdmissionProblem | undefined {
  if (peer.tags.every((tag) => !tags.includes(tag))) {
    return 'untagged';
  }
  if (peer.routes) {
    return 'router';
  }
  return peer.addresses.includes(address.toLowerCase()) ? undefined : 'address';
}
