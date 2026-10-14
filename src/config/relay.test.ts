import { describe, expect, it } from 'vitest';

import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { loadConfig } from './index.ts';
import { DEFAULT_TAILSCALE_SOCKET, parseRelayListen } from './relay.ts';

const REQUIRED = {
  VAULTGATE_PUBLIC_URL: 'https://vault.example.com',
  VAULTGATE_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
};

const COLLECTION = '5D0C7A1E-0000-4000-8000-00000000C001';
const ITEM = '0f6b2d3c-0000-4000-8000-000000000002';

const ENABLED = {
  ...REQUIRED,
  VAULTGATE_RELAY_LISTEN: '100.64.0.10:8087',
  VAULTGATE_RELAY_TAGS: 'tag:Sandbox, tag:ci,tag:sandbox',
  VAULTGATE_RELAY_COLLECTIONS: COLLECTION,
};

function issues(environment: Record<string, string>): string {
  return unwrapFail(loadConfig(environment)).message;
}

describe('parseRelayListen', () => {
  it('RELAY-2 reads an IPv4 or bracketed IPv6 address and a port', () => {
    expect(parseRelayListen('100.64.0.10:8087')).toStrictEqual({ host: '100.64.0.10', port: 8087 });
    expect(parseRelayListen(' [fd7a:115c:a1e0::a]:443 ')).toStrictEqual({
      host: 'fd7a:115c:a1e0::a',
      port: 443,
    });
  });

  it('RELAY-2 refuses a host name, a wildcard, a missing or out-of-range port', () => {
    expect(parseRelayListen('vault.example.ts.net:8087')).toMatch(/IP address, not a host name/);
    expect(parseRelayListen('0.0.0.0:8087')).toMatch(/wildcard/);
    expect(parseRelayListen('[::]:8087')).toMatch(/wildcard/);
    expect(parseRelayListen('100.64.0.10')).toMatch(/IP address and a port/);
    expect(parseRelayListen('100.64.0.10:http')).toMatch(/IP address and a port/);
    expect(parseRelayListen('fd7a::1:8087')).toMatch(/IPv6 address, and only an IPv6 address/);
    expect(parseRelayListen('[100.64.0.10]:8087')).toMatch(/only an IPv6 address, in brackets/);
    expect(parseRelayListen('100.64.0.10:0')).toMatch(/port from 1 to 65535/);
    expect(parseRelayListen('100.64.0.10:70000')).toMatch(/port from 1 to 65535/);
  });
});

describe('relay configuration', () => {
  it('RELAY-1 leaves the relay off unless a listen address is set', () => {
    const { config } = unwrapOk(loadConfig(REQUIRED));
    expect(config.relay).toStrictEqual({
      listen: undefined,
      tags: [],
      collections: [],
      items: [],
      tailscaleSocket: DEFAULT_TAILSCALE_SOCKET,
    });
  });

  it('RELAY-1 reads the listen address, tags and scope, lower-cased and de-duplicated', () => {
    const { config } = unwrapOk(
      loadConfig({
        ...ENABLED,
        VAULTGATE_RELAY_ITEMS: `${ITEM},`,
        VAULTGATE_RELAY_TAILSCALE_SOCKET: '/run/tailscale/tailscaled.sock',
      }),
    );
    expect(config.relay).toStrictEqual({
      listen: { host: '100.64.0.10', port: 8087 },
      tags: ['tag:sandbox', 'tag:ci'],
      collections: [COLLECTION.toLowerCase()],
      items: [ITEM],
      tailscaleSocket: '/run/tailscale/tailscaled.sock',
    });
  });

  it('RELAY-1 requires a tag and something in scope once a listen address is set', () => {
    const message = issues({ ...REQUIRED, VAULTGATE_RELAY_LISTEN: '100.64.0.10:8087' });
    expect(message).toContain('VAULTGATE_RELAY_TAGS: is required when VAULTGATE_RELAY_LISTEN');
    expect(message).toContain('VAULTGATE_RELAY_COLLECTIONS: or VAULTGATE_RELAY_ITEMS is required');
    const onlyItems = loadConfig({
      ...ENABLED,
      VAULTGATE_RELAY_COLLECTIONS: '',
      VAULTGATE_RELAY_ITEMS: ITEM,
    });
    expect(unwrapOk(onlyItems).config.relay.items).toStrictEqual([ITEM]);
  });

  it('RELAY-1 refuses a malformed listen address, tag, id or socket path', () => {
    expect(issues({ ...ENABLED, VAULTGATE_RELAY_LISTEN: '0.0.0.0:8087' })).toContain(
      'VAULTGATE_RELAY_LISTEN: must name one address',
    );
    expect(issues({ ...ENABLED, VAULTGATE_RELAY_TAGS: 'sandbox' })).toContain(
      '"sandbox" is not a Tailscale tag',
    );
    expect(issues({ ...ENABLED, VAULTGATE_RELAY_COLLECTIONS: 'Cloud helpers' })).toContain(
      '"Cloud helpers" is not a vault id',
    );
    expect(issues({ ...ENABLED, VAULTGATE_RELAY_TAILSCALE_SOCKET: 'tailscaled.sock' })).toContain(
      'VAULTGATE_RELAY_TAILSCALE_SOCKET',
    );
  });
});
