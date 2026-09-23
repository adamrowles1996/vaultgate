import { describe, expect, it } from 'vitest';

import { resolveClientIp } from './client-ip.ts';

const SOCKET = '10.0.0.7';
const TRUSTED = { trustProxy: true, trustedProxyHops: 1 };

function resolve(forwardedFor: string | null | undefined, hops = 1): string | undefined {
  return resolveClientIp(
    { forwardedFor, socketAddress: SOCKET },
    { trustProxy: true, trustedProxyHops: hops },
  );
}

describe('resolveClientIp', () => {
  it('OPS-6 ignores X-Forwarded-For entirely when the proxy is not trusted', () => {
    const untrusted = { trustProxy: false, trustedProxyHops: 1 };
    expect(resolveClientIp({ forwardedFor: '1.2.3.4', socketAddress: SOCKET }, untrusted)).toBe(
      SOCKET,
    );
    expect(resolveClientIp({ forwardedFor: '1.2.3.4', socketAddress: undefined }, untrusted)).toBe(
      undefined,
    );
  });

  it('OPS-6 takes the rightmost entry behind one trusted proxy, ignoring everything the client wrote', () => {
    expect(resolve('1.2.3.4')).toBe('1.2.3.4');
    expect(resolve('6.6.6.6, 1.2.3.4')).toBe('1.2.3.4');
    expect(resolve('6.6.6.6,7.7.7.7 , 2001:db8::1 ')).toBe('2001:db8::1');
  });

  it('OPS-6 counts the configured number of hops from the right', () => {
    expect(resolve('6.6.6.6, 1.2.3.4, 192.0.2.10', 2)).toBe('1.2.3.4');
    expect(resolve('1.2.3.4, 192.0.2.10', 2)).toBe('1.2.3.4');
  });

  it('OPS-6 falls back to the socket address when the header is absent, short or malformed', () => {
    expect(resolve(null)).toBe(SOCKET);
    expect(resolve(undefined)).toBe(SOCKET);
    expect(resolve('')).toBe(SOCKET);
    expect(resolve('1.2.3.4', 2)).toBe(SOCKET);
    expect(resolve('unknown')).toBe(SOCKET);
    expect(resolve('1.2.3.4:5678')).toBe(SOCKET);
    expect(resolve('6.6.6.6, not-an-ip')).toBe(SOCKET);
    expect(resolveClientIp({ forwardedFor: 'x', socketAddress: undefined }, TRUSTED)).toBe(
      undefined,
    );
  });
});
