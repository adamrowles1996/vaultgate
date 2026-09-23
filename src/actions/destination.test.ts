import { describe, expect, it } from 'vitest';

import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { pinEndpoint } from './destination.ts';

import type { Lookup } from '../net/ip-ranges.ts';

const ENDPOINT = { host: 'api.example.com', tls: true };

function answering(addresses: readonly string[]): Lookup {
  return () => Promise.resolve(addresses);
}

const NEVER: Lookup = () => Promise.reject(new Error('must not resolve'));

describe('pinEndpoint', () => {
  it('ACT-55 resolves the host once through the injected resolver and pins the first address', async () => {
    const seen: string[] = [];
    const lookup: Lookup = (hostname) => {
      seen.push(hostname);
      return Promise.resolve(['93.184.216.34', '2606:4700::1111']);
    };
    expect(unwrapOk(await pinEndpoint(ENDPOINT, false, lookup))).toStrictEqual({
      host: 'api.example.com',
      tls: true,
      address: '93.184.216.34',
    });
    expect(seen).toStrictEqual(['api.example.com']);
  });

  it('ACT-55 ACT-3 validates an IP literal without resolving it, IPv6 brackets included', async () => {
    expect(
      unwrapOk(await pinEndpoint({ host: '93.184.216.34', tls: true }, false, NEVER)).address,
    ).toBe('93.184.216.34');
    expect(
      unwrapOk(await pinEndpoint({ host: '[2606:4700::1111]', tls: true }, false, NEVER)).address,
    ).toBe('2606:4700::1111');
    expect(
      unwrapFail(await pinEndpoint({ host: '10.0.0.5', tls: false }, false, NEVER)),
    ).toMatchObject({
      problem: 'private',
      host: '10.0.0.5',
    });
  });

  it('ACT-56 refuses a private-range address unless the target is internal', async () => {
    const addresses = [
      '10.1.2.3',
      '100.64.0.1',
      '172.16.0.1',
      '192.168.1.1',
      'fd12::1',
      '::ffff:10.0.0.1',
    ];
    for (const address of addresses) {
      const lookup = answering([address]);
      const refused = unwrapFail(await pinEndpoint(ENDPOINT, false, lookup));
      expect(refused).toMatchObject({ name: 'DestinationRefusal', problem: 'private' });
      expect(refused.message).toBe(
        'host "api.example.com" is a private-range address; set internal: true to allow it',
      );
      expect(unwrapOk(await pinEndpoint(ENDPOINT, true, lookup)).address).toBe(address);
    }
  });

  it('ACT-56 refuses loopback, link-local, multicast and unspecified addresses whatever internal says', async () => {
    const addresses = [
      '127.0.0.1',
      '::1',
      '169.254.169.254',
      'fe80::1',
      '224.0.0.1',
      '0.0.0.0',
      '::ffff:127.0.0.1',
    ];
    for (const address of addresses) {
      const lookup = answering([address]);
      expect(unwrapFail(await pinEndpoint(ENDPOINT, true, lookup)).problem).toBe('forbidden');
      expect(unwrapFail(await pinEndpoint(ENDPOINT, false, lookup)).message).toBe(
        'host "api.example.com" is a loopback, link-local, multicast or unspecified address, which is refused always',
      );
    }
  });

  it('ACT-56 refuses a host when any of its addresses is refused', async () => {
    const lookup = answering(['93.184.216.34', '127.0.0.1']);
    expect(unwrapFail(await pinEndpoint(ENDPOINT, true, lookup)).problem).toBe('forbidden');
  });

  it('ACT-55 refuses a host with no address, whether the resolver answers empty or throws, and an answer that is not an address', async () => {
    const empty = answering([]);
    expect(unwrapFail(await pinEndpoint(ENDPOINT, false, empty)).problem).toBe('unresolved');
    expect(unwrapFail(await pinEndpoint(ENDPOINT, false, NEVER))).toMatchObject({
      problem: 'unresolved',
      message: 'host "api.example.com" does not resolve to any address',
    });
    const nonsense = answering(['nonsense']);
    expect(unwrapFail(await pinEndpoint(ENDPOINT, false, nonsense))).toMatchObject({
      problem: 'invalid',
      message: 'host "api.example.com" is not a valid address',
    });
  });
});
