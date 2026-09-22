import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createClientIpResolver } from './client-ip.ts';

async function resolveWith(
  options: { trustProxy: boolean; socket: string | undefined },
  headers: Record<string, string>,
): Promise<string> {
  const resolver = createClientIpResolver({
    trustProxy: options.trustProxy,
    socketAddress: () => options.socket,
  });
  const app = new Hono().get('/', (context) => context.text(resolver(context)));
  const response = await app.request('/', { headers });
  return response.text();
}

describe('createClientIpResolver', () => {
  it('OPS-6 ignores X-Forwarded-For unless the proxy is trusted', async () => {
    expect(
      await resolveWith(
        { trustProxy: false, socket: '10.0.0.9' },
        { 'x-forwarded-for': '1.2.3.4' },
      ),
    ).toBe('10.0.0.9');
  });

  it('OPS-6 uses the first forwarded address when the proxy is trusted', async () => {
    expect(
      await resolveWith(
        { trustProxy: true, socket: '10.0.0.9' },
        { 'x-forwarded-for': ' 1.2.3.4 , 5.6.7.8' },
      ),
    ).toBe('1.2.3.4');
  });

  it('OPS-6 falls back to the socket when the forwarded header is empty', async () => {
    expect(
      await resolveWith({ trustProxy: true, socket: '10.0.0.9' }, { 'x-forwarded-for': ' ' }),
    ).toBe('10.0.0.9');
    expect(await resolveWith({ trustProxy: true, socket: '10.0.0.9' }, {})).toBe('10.0.0.9');
  });

  it('OPS-6 reports unknown when there is no socket address', async () => {
    expect(await resolveWith({ trustProxy: false, socket: undefined }, {})).toBe('unknown');
  });
});
