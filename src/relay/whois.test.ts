import { describe, expect, it, vi } from 'vitest';

import { createWhoIs, isAdmitted } from './whois.ts';

import type { LocalHttp, LocalRequest } from '../net/local-http.ts';

function answering(status: number, body: string): LocalHttp & { calls: LocalRequest[] } {
  const calls: LocalRequest[] = [];
  const http = vi.fn((request: LocalRequest) => {
    calls.push(request);
    return Promise.resolve({ status, body: Buffer.from(body) });
  });
  return Object.assign(http, { calls });
}

const NODE = JSON.stringify({
  Node: { Name: 'sandbox-1.example.ts.net.', Tags: ['tag:Sandbox', 'tag:ci'], ID: 7 },
  UserProfile: { LoginName: 'tagged-devices' },
});

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
    const http = answering(200, NODE);
    const peer = await createWhoIs(http)('100.64.0.20');
    expect(peer).toStrictEqual({
      node: 'sandbox-1.example.ts.net',
      tags: ['tag:sandbox', 'tag:ci'],
    });
    const [call] = http.calls;
    expect(call?.method).toBe('GET');
    expect(call?.path).toBe('/localapi/v0/whois?addr=100.64.0.20');
    expect(call?.headers).toStrictEqual({ host: 'local-tailscaled.sock' });
    expect(call?.maxResponseBytes).toBe(256 * 1024);
  });

  it('RELAY-3 encodes an IPv6 address and reads an untagged node as having no tags', async () => {
    const http = answering(200, JSON.stringify({ Node: { Name: 'laptop.example.ts.net.' } }));
    const peer = await createWhoIs(http, 50)('fd7a:115c:a1e0::5');
    expect(peer).toStrictEqual({ node: 'laptop.example.ts.net', tags: [] });
    expect(http.calls[0]?.path).toBe('/localapi/v0/whois?addr=fd7a%3A115c%3Aa1e0%3A%3A5');
    const nullTags = answering(200, JSON.stringify({ Node: { Name: 'n.ts.net', Tags: null } }));
    expect(await createWhoIs(nullTags)('100.64.0.21')).toStrictEqual({
      node: 'n.ts.net',
      tags: [],
    });
  });

  it('RELAY-3 names no peer for a refusal, a non-JSON body, an unknown shape or a failure', async () => {
    const refusals: LocalHttp[] = [
      answering(404, 'no match for IP:port'),
      answering(200, 'not json'),
      answering(200, JSON.stringify({ Node: { Name: '' } })),
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

describe('isAdmitted', () => {
  it('RELAY-3 admits a node carrying any one of the listed tags', () => {
    const peer = { node: 'n', tags: ['tag:ci', 'tag:sandbox'] };
    expect(isAdmitted(peer, ['tag:sandbox'])).toBe(true);
    expect(isAdmitted(peer, ['tag:servers'])).toBe(false);
    expect(isAdmitted({ node: 'n', tags: [] }, ['tag:sandbox'])).toBe(false);
  });
});
