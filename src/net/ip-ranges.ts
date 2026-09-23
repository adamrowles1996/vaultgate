import { BlockList, isIP } from 'node:net';

/**
 * Resolves a host name to every address it maps to. Injected (QG-2) so no
 * test touches DNS; production wires `dns.lookup` with `all: true`.
 */
export type Lookup = (hostname: string) => Promise<readonly string[]>;

/**
 * How an address may be used as a destination (OAUTH-8, T6; ACT-56):
 * `public` connects anywhere; `private` (RFC 1918, carrier-grade NAT, unique
 * local IPv6) only where a caller has opted in; `forbidden` never (loopback,
 * link-local including cloud metadata endpoints, multicast, unspecified,
 * documentation, benchmarking, NAT64 and reserved space); `invalid` is not an
 * IP address at all.
 */
export type AddressClass = 'public' | 'private' | 'forbidden' | 'invalid';

type Subnet = readonly [network: string, prefix: number];

const PRIVATE_V4: readonly Subnet[] = [
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
];

const PRIVATE_V6: readonly Subnet[] = [['fc00::', 7]];

const FORBIDDEN_V4: readonly Subnet[] = [
  ['0.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const FORBIDDEN_V6: readonly Subnet[] = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2001:db8::', 32],
  ['fe80::', 10],
  ['ff00::', 8],
];

const IPV4_MAPPED_PREFIX = '::ffff:';

function buildBlockList(v4: readonly Subnet[], v6: readonly Subnet[]): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of v4) {
    list.addSubnet(network, prefix, 'ipv4');
  }
  for (const [network, prefix] of v6) {
    list.addSubnet(network, prefix, 'ipv6');
  }
  return list;
}

const PRIVATE = buildBlockList(PRIVATE_V4, PRIVATE_V6);
const FORBIDDEN = buildBlockList(FORBIDDEN_V4, FORBIDDEN_V6);

/**
 * Classifies one address. IPv4-mapped IPv6 forms are judged by the embedded
 * IPv4 address, so `::ffff:10.0.0.1` is private and `::ffff:127.0.0.1` is
 * forbidden: the mapping is never a way around the rule.
 */
export function classifyAddress(address: string): AddressClass {
  const unmapped = address.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)
    ? address.slice(IPV4_MAPPED_PREFIX.length)
    : address;
  const version = isIP(unmapped);
  if (version === 0) {
    return 'invalid';
  }
  const family = version === 4 ? 'ipv4' : 'ipv6';
  if (FORBIDDEN.check(unmapped, family)) {
    return 'forbidden';
  }
  return PRIVATE.check(unmapped, family) ? 'private' : 'public';
}

/**
 * True only for a syntactically valid, globally routable unicast address.
 */
export function isPublicAddress(address: string): boolean {
  return classifyAddress(address) === 'public';
}
