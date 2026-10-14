import { describe, expect, it, vi } from 'vitest';

import { admissionProblem, createWhoIs, type TailnetPeer } from './whois.ts';

import type { LocalHttp, LocalRequest } from '../net/local-http.ts';

function answering(status: number, body: string): LocalHttp & { calls: LocalRequest[] } {
  const calls: LocalRequest[] = [];
  const http = vi.fn((request: LocalRequest) => {
    calls.push(request);
    return Promise.resolve({ status, body: Buffer.from(body) });
  });
  return Object.assign(http, { calls });
}

const OWN = ['100.64.0.20/32', 'FD7A:115C:A1E0::20/128'];

function node(fields: Record<string, unknown>): string {
  return JSON.stringify({
    Node: { Name: 'sandbox-1.example.ts.net.', Addresses: OWN, ...fields },
    UserProfile: { LoginName: 'tagged-devices' },
  });
}

/**
A LocalAPI that never answers, so only the request's own timeout can end the question.
*/
const NEVER_ANSWERS: LocalHttp = async (request) =>
  new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => {
      reject(request.signal.reason as Error);
    });
  });

describe('createWhoIs', () => {
  it('RELAY-3 asks the LocalAPI about the address with its required Host', async () => {
    const http = answering(200, node({ Tags: ['tag:Sandbox', 'tag:ci'], AllowedIPs: OWN, ID: 7 }));
    const peer = await createWhoIs(http)('100.64.0.20');
    expect(peer).toStrictEqual({
      node: 'sandbox-1.example.ts.net',
      tags: ['tag:sandbox', 'tag:ci'],
      addresses: ['100.64.0.20', 'fd7a:115c:a1e0::20'],
      routes: false,
    });
    const [call] = http.calls;
    expect(call?.method).toBe('GET');
    expect(call?.path).toBe('/localapi/v0/whois?addr=100.64.0.20');
    expect(call?.headers).toStrictEqual({ host: 'local-tailscaled.sock' });
    expect(call?.maxResponseBytes).toBe(256 * 1024);
  });

  it('RELAY-3 encodes an IPv6 address and reads an untagged node as having no tags', async () => {
    const http = answering(200, node({}));
    const peer = await createWhoIs(http, 50)('fd7a:115c:a1e0::5');
    expect(peer?.tags).toStrictEqual([]);
    expect(peer?.routes).toBe(false);
    expect(http.calls[0]?.path).toBe('/localapi/v0/whois?addr=fd7a%3A115c%3Aa1e0%3A%3A5');
    const nullFields = answering(200, node({ Tags: null, AllowedIPs: null, PrimaryRoutes: null }));
    const peerWithNulls = await createWhoIs(nullFields)('100.64.0.21');
    expect(peerWithNulls?.tags).toStrictEqual([]);
    expect(peerWithNulls?.routes).toBe(false);
  });

  it('RELAY-3 marks a subnet router or an exit node as routing for others', async () => {
    const routing = [
      node({ AllowedIPs: [...OWN, '192.168.1.0/24'] }),
      node({ AllowedIPs: [...OWN, '0.0.0.0/0', '::/0'] }),
      node({ AllowedIPs: OWN, PrimaryRoutes: ['10.1.0.0/16'] }),
    ];
    const peers = await Promise.all(
      routing.map(async (body) => createWhoIs(answering(200, body))('100.64.0.20')),
    );
    expect(peers.map((peer) => peer?.routes)).toStrictEqual([true, true, true]);
  });

  it('RELAY-3 names no peer for a refusal, a non-JSON body, an unknown shape or a failure', async () => {
    const refusals: LocalHttp[] = [
      answering(404, 'no match for IP:port'),
      answering(200, 'not json'),
      answering(200, node({ Name: '' })),
      answering(200, node({ Addresses: [] })),
      answering(200, JSON.stringify({ Peer: {} })),
      () => Promise.reject(new Error('ENOENT')),
    ];
    for (const http of refusals) {
      expect(await createWhoIs(http)('100.64.0.20')).toBeUndefined();
    }
  });

  it('RELAY-3 bounds each question with a timeout signal', async () => {
    expect(await createWhoIs(NEVER_ANSWERS, 5)('100.64.0.20')).toBeUndefined();
  });
});

describe('admissionProblem', () => {
  const peer: TailnetPeer = {
    node: 'n',
    tags: ['tag:ci', 'tag:sandbox'],
    addresses: ['100.64.0.20', 'fd7a:115c:a1e0::20'],
    routes: false,
  };

  it('RELAY-3 admits a node carrying any one of the listed tags, from its own address', () => {
    expect(admissionProblem(peer, ['tag:sandbox'], '100.64.0.20')).toBeUndefined();
    expect(admissionProblem(peer, ['tag:sandbox'], 'FD7A:115C:A1E0::20')).toBeUndefined();
  });

  it('RELAY-3 refuses an untagged node, a router, and an address that is not the node’s own', () => {
    expect(admissionProblem(peer, ['tag:servers'], '100.64.0.20')).toBe('untagged');
    expect(admissionProblem({ ...peer, tags: [] }, ['tag:sandbox'], '100.64.0.20')).toBe(
      'untagged',
    );
    expect(admissionProblem({ ...peer, routes: true }, ['tag:sandbox'], '100.64.0.20')).toBe(
      'router',
    );
    expect(admissionProblem(peer, ['tag:sandbox'], '192.168.1.50')).toBe('address');
  });
});
