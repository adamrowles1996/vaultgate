import { describe, expect, it } from 'vitest';

import { isPublicAddress } from './ip-ranges.ts';

describe('isPublicAddress', () => {
  it.each(['93.184.216.34', '8.8.8.8', '2606:4700::1111', '::ffff:93.184.216.34'])(
    'OAUTH-8 accepts the public address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it.each([
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::ffff:10.0.0.1',
    '::FFFF:127.0.0.1',
    '64:ff9b::a00:1',
    '64:ff9b:1::1',
    '2001:db8::1',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    'ff02::1',
  ])('T6 rejects the non-public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it('T6 rejects anything that is not an IP address', () => {
    expect(isPublicAddress('example.com')).toBe(false);
    expect(isPublicAddress('')).toBe(false);
    expect(isPublicAddress('::ffff:example.com')).toBe(false);
  });
});
