/**
 * Who a relay caller is (RELAY-3): the local Tailscale daemon's LocalAPI
 * `whois` names the tailnet node behind a peer address, and its tags. The
 * daemon is the authority because it holds the tailnet's key for every
 * peer: an address it does not map to a node is not a tailnet peer at all.
 * Any failure, a slow answer or a shape this module does not recognise
 * resolves to no peer, so the caller is refused rather than guessed at.
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
}

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
});

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
  const { Name, Tags } = parsed.data.Node;
  return {
    node: Name.replace(/\.$/, ''),
    tags: (Tags ?? []).map((tag) => tag.toLowerCase()),
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
Whether `peer` carries at least one of `tags` (both sides lower-cased).
*/
export function isAdmitted(peer: TailnetPeer, tags: readonly string[]): boolean {
  return peer.tags.some((tag) => tags.includes(tag));
}
