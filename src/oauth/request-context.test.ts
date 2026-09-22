import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { clientIpResolver } from './request-context.ts';

import type { IdentityEnvironment } from '../identity/context.ts';

async function resolvedIp(ip: string | undefined): Promise<string> {
  const resolver = clientIpResolver({ clientInfo: () => ({ ip, userAgent: undefined }) });
  const app = new Hono<IdentityEnvironment>().get('/', (context) =>
    context.text(resolver(context)),
  );
  const response = await app.request('/');
  return response.text();
}

describe('clientIpResolver', () => {
  it("OPS-6 uses the guards' proxy-aware address", async () => {
    expect(await resolvedIp('198.51.100.4')).toBe('198.51.100.4');
  });

  it('OPS-6 keys on a fixed value when the listener reports no address', async () => {
    expect(await resolvedIp(undefined)).toBe('unknown');
  });
});
