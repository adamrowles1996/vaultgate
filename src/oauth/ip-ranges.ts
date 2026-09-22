import { BlockList, isIP } from 'node:net';

/**
 * Address ranges a CIMD fetch must never connect to (OAUTH-8, T6):
 * unspecified, loopback, private, link-local, carrier-grade NAT, documentation,
 * benchmarking, multicast and reserved space, for both address families and
 * for IPv4 addresses embedded in IPv6.
 */
const IPV4_BLOCKED: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const IPV6_BLOCKED: readonly (readonly [string, number])[] = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
];

const IPV4_MAPPED_PREFIX = '::ffff:';

function buildBlockList(): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of IPV4_BLOCKED) {
    list.addSubnet(network, prefix, 'ipv4');
  }
  for (const [network, prefix] of IPV6_BLOCKED) {
    list.addSubnet(network, prefix, 'ipv6');
  }
  return list;
}

const BLOCKED = buildBlockList();

/**
 * True only for a syntactically valid, globally routable unicast address.
 */
export function isPublicAddress(address: string): boolean {
  const unmapped = address.toLowerCase().startsWith(IPV4_MAPPED_PREFIX)
    ? address.slice(IPV4_MAPPED_PREFIX.length)
    : address;
  const family = isIP(unmapped);
  return family !== 0 && !BLOCKED.check(unmapped, family === 4 ? 'ipv4' : 'ipv6');
}
