import { describe, expect, it, vi } from 'vitest';

import {
  PEER,
  PEER_ADDRESS,
  relayGet,
  relayHarness,
  RELAY_ID,
  relayStatus,
} from '../test-support/relay-fixtures.ts';

import { RATE_LIMIT_PER_MINUTE } from './app.ts';

import type { WhoIs } from './whois.ts';

const PASSWORD_PATH = `/object/password/${RELAY_ID.database}`;

function denials(events: readonly { action: string; details?: unknown }[]): readonly unknown[] {
  return events.filter((event) => event.action === 'relay.denied').map((event) => event.details);
}

describe('relay admission', () => {
  it('RELAY-3 answers a tagged tailnet peer, asking the daemon about the socket address', async () => {
    const whoIs = vi.fn<WhoIs>(() => Promise.resolve(PEER));
    const harness = relayHarness({ whoIs });
    const response = await relayGet(harness, PASSWORD_PATH, { 'x-forwarded-for': '100.64.0.99' });
    expect(response.status).toBe(200);
    expect(whoIs).toHaveBeenCalledWith(PEER_ADDRESS);
  });

  it('RELAY-3 asks about the IPv4 address behind an IPv4-mapped socket address', async () => {
    const whoIs = vi.fn<WhoIs>(() => Promise.resolve(PEER));
    const harness = relayHarness({ whoIs, peerAddress: `::ffff:${PEER_ADDRESS}` });
    expect(await relayStatus(harness, '/status')).toBe(200);
    expect(whoIs).toHaveBeenCalledWith(PEER_ADDRESS);
  });

  it('RELAY-3 refuses a request that carries a browser Origin', async () => {
    const whoIs = vi.fn<WhoIs>(() => Promise.resolve(PEER));
    const harness = relayHarness({ whoIs });
    const response = await relayGet(harness, PASSWORD_PATH, { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(await response.json()).toStrictEqual({ success: false, message: 'Forbidden.' });
    expect(whoIs).not.toHaveBeenCalled();
    expect(denials(harness.audit.events)).toStrictEqual([{ reason: 'origin' }]);
  });

  it('RELAY-2 refuses a Host that is not the listen address, or no Host at all', async () => {
    const harness = relayHarness();
    const renamed = await relayGet(harness, PASSWORD_PATH, { host: 'relay.example:8087' });
    expect(renamed.status).toBe(403);
    const bare = await harness.app.request(PASSWORD_PATH);
    expect(bare.status).toBe(403);
    expect(denials(harness.audit.events)).toStrictEqual([{ reason: 'host' }, { reason: 'host' }]);
  });

  it('RELAY-2 accepts the bare address on port 80 and a bracketed IPv6 listen address', async () => {
    const onPort80 = relayHarness({ listen: { host: '100.64.0.10', port: 80 } });
    expect(await relayStatus(onPort80, '/status', { host: '100.64.0.10' })).toBe(200);
    expect(await relayStatus(onPort80, '/status', { host: '100.64.0.10:80' })).toBe(200);
    const v6 = relayHarness({ listen: { host: 'FD7A:115C:A1E0::A', port: 8087 } });
    expect(await relayStatus(v6, '/status', { host: '[fd7a:115c:a1e0::a]:8087' })).toBe(200);
    expect(await relayStatus(v6, '/status', { host: 'fd7a:115c:a1e0::a' })).toBe(403);
  });

  it('RELAY-3 refuses a request whose socket address is unknown', async () => {
    const harness = relayHarness({ peerAddress: undefined });
    expect(await relayStatus(harness, PASSWORD_PATH)).toBe(403);
    expect(denials(harness.audit.events)).toStrictEqual([{ reason: 'no_address' }]);
  });

  it('RELAY-3 refuses an address the Tailscale daemon does not name', async () => {
    const harness = relayHarness({ whoIs: () => Promise.resolve(undefined) });
    expect(await relayStatus(harness, PASSWORD_PATH)).toBe(403);
    expect(denials(harness.audit.events)).toStrictEqual([{ reason: 'not_a_peer' }]);
    expect(harness.audit.events[0]?.ip).toBe(PEER_ADDRESS);
  });

  it('RELAY-3 refuses a node that carries none of the listed tags', async () => {
    const userNode = { node: 'laptop.example.ts.net', tags: [] };
    const harness = relayHarness({ whoIs: () => Promise.resolve(userNode) });
    const response = await relayGet(harness, PASSWORD_PATH);
    expect(response.status).toBe(403);
    expect(denials(harness.audit.events)).toStrictEqual([
      { reason: 'untagged', node: 'laptop.example.ts.net' },
    ]);
    expect(harness.logged()).toContain('relay refused');
  });

  it('RELAY-9 limits each node, answers 429 with Retry-After, and refills', async () => {
    const nodes = { current: PEER };
    const harness = relayHarness({ whoIs: () => Promise.resolve(nodes.current) });
    for (let request = 0; request < RATE_LIMIT_PER_MINUTE; request += 1) {
      expect(await relayStatus(harness, '/status')).toBe(200);
    }
    const limited = await relayGet(harness, '/status');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('1');
    expect(await limited.json()).toStrictEqual({ success: false, message: 'Too many requests.' });
    nodes.current = { node: 'sandbox-2.example.ts.net', tags: ['tag:sandbox'] };
    expect(await relayStatus(harness, '/status')).toBe(200);
    nodes.current = PEER;
    harness.advance(60_000);
    expect(await relayStatus(harness, '/status')).toBe(200);
    expect(denials(harness.audit.events)).toStrictEqual([
      { reason: 'rate_limited', node: PEER.node },
    ]);
  });

  it('RELAY-5 admits before routing, so an unknown route is refused to a stranger', async () => {
    const stranger = relayHarness({ whoIs: () => Promise.resolve(undefined) });
    expect(await relayStatus(stranger, '/unlock')).toBe(403);
    const peer = relayHarness();
    const unknown = await relayGet(peer, '/unlock');
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toStrictEqual({ success: false, message: 'Unknown route.' });
  });
});
