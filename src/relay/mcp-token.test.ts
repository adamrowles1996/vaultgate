import { describe, expect, it } from 'vitest';

import { PEER, PEER_ADDRESS, RELAY_HOST, relayHarness } from '../test-support/relay-fixtures.ts';

import type { Caller } from './handlers.ts';
import type { IssueMcpToken } from './mcp-token.ts';

const TOKEN = {
  object: 'token',
  access_token: 'vg_at_relay-test-token',
  token_type: 'Bearer',
  expires_in: 3600,
  scope: 'vault:read',
  resource: 'https://vault.example.com/mcp',
};

function issuer(isAnswered: boolean): { issue: IssueMcpToken; callers: Caller[] } {
  const callers: Caller[] = [];
  return {
    callers,
    issue: (caller) => {
      callers.push(caller);
      return isAnswered
        ? { clientId: 'client-a', tokenId: 'aabbccdd0011', token: TOKEN }
        : undefined;
    },
  };
}

async function post(
  harness: ReturnType<typeof relayHarness>,
  headers: Readonly<Record<string, string>> = {},
): Promise<Response> {
  return harness.app.request('/mcp/token', {
    method: 'POST',
    headers: { host: RELAY_HOST, ...headers },
  });
}

describe('relay /mcp/token', () => {
  it('RELAY-14 answers an unknown route when no client is configured', async () => {
    const harness = relayHarness();
    const response = await post(harness);
    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({ success: false, message: 'Unknown route.' });
  });

  it('RELAY-14 issues an admitted node a token in the relay envelope, on POST only', async () => {
    const { issue, callers } = issuer(true);
    const harness = relayHarness({ issueMcpToken: issue });
    const response = await post(harness);
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ success: true, data: TOKEN });
    expect(callers).toStrictEqual([{ node: PEER.node, ip: PEER_ADDRESS }]);
    const get = await harness.app.request('/mcp/token', { headers: { host: RELAY_HOST } });
    expect(get.status).toBe(404);
    expect(callers).toHaveLength(1);
  });

  it('RELAY-14 issues nothing to a caller the admission check refuses', async () => {
    const { issue, callers } = issuer(true);
    const harness = relayHarness({ issueMcpToken: issue });
    const response = await post(harness, { origin: 'https://evil.example' });
    expect(response.status).toBe(403);
    expect(callers).toStrictEqual([]);
  });

  it('RELAY-15 answers 503 when there is no consent to issue under', async () => {
    const harness = relayHarness({ issueMcpToken: issuer(false).issue });
    const response = await post(harness);
    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual({
      success: false,
      message: 'No consent to issue under.',
    });
    expect(harness.audit.events).toStrictEqual([
      {
        category: 'relay',
        action: 'relay.mcp_token',
        outcome: 'failure',
        clientId: undefined,
        tokenPrefix: undefined,
        ip: PEER_ADDRESS,
        details: { node: PEER.node, reason: 'no_consent' },
      },
    ]);
  });

  it('RELAY-16 audits each issue with the node, client and token prefix, never the token', async () => {
    const harness = relayHarness({ issueMcpToken: issuer(true).issue });
    await post(harness);
    expect(harness.audit.events).toStrictEqual([
      {
        category: 'relay',
        action: 'relay.mcp_token',
        outcome: 'ok',
        clientId: 'client-a',
        tokenPrefix: 'aabbccdd0011',
        ip: PEER_ADDRESS,
        details: { node: PEER.node },
      },
    ]);
    expect(JSON.stringify(harness.audit.events)).not.toContain(TOKEN.access_token);
    expect(harness.logged()).not.toContain(TOKEN.access_token);
  });
});
