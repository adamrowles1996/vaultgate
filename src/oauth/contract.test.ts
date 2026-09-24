import { auth } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';

import { setUpOperator } from '../test-support/identity-app.ts';
import { RESOURCE } from '../test-support/oauth-harness.ts';
import {
  CIMD_ID,
  DESK,
  fetchThrough,
  handshake,
  mcpStatus,
  newHarness,
  SCOPE,
  TestProvider,
} from '../test-support/sdk-client.ts';

describe('OAuth contract with the MCP client SDK', () => {
  it('completes the CIMD handshake and the token is accepted by /mcp', async () => {
    const harness = newHarness();
    const { provider, tokens } = await handshake(harness, new TestProvider({ cimd: true }));
    expect(provider.clientInformation()?.client_id).toBe(CIMD_ID);
    expect(tokens.access_token).toMatch(/^vg_at_/);
    expect(tokens.refresh_token).toMatch(/^vg_rt_/);
    expect(tokens.scope).toBe(SCOPE);
    expect(harness.repos.clients.findByClientId(CIMD_ID)?.mode).toBe('cimd');
    const verified = await harness.server.tokenVerifier.verify(tokens.access_token);
    expect(verified.ok).toBe(true);
    expect(await mcpStatus(harness, tokens.access_token)).toBe(200);
    expect(await mcpStatus(harness, undefined)).toBe(401);
  });

  it('completes the handshake for an operator who set up and logged in through the real pages', async () => {
    const harness = newHarness();
    const setup = await setUpOperator(harness.identity);
    const browser = harness.browser();
    for (const [name, value] of setup.browser.cookies) {
      browser.cookies.set(name, value);
    }
    const { tokens } = await handshake(harness, new TestProvider({ cimd: true }), browser);
    expect(await mcpStatus(harness, tokens.access_token)).toBe(200);
    const agents = await browser.get('/account/agents');
    expect(await agents.text()).toContain('<h3>CIMD Agent</h3>');
  });

  it('completes the DCR handshake, minting a vg_c_ client without a secret', async () => {
    const harness = newHarness();
    const { provider, tokens } = await handshake(harness, new TestProvider());
    const information = provider.clientInformation();
    expect(information?.client_id).toMatch(/^vg_c_/);
    expect(information).not.toHaveProperty('client_secret');
    expect(harness.repos.clients.findByClientId(information?.client_id ?? '')?.mode).toBe('dcr');
    expect(await mcpStatus(harness, tokens.access_token)).toBe(200);
  });

  it('completes the pre-registered handshake', async () => {
    const harness = newHarness({ oauthClients: [DESK] });
    const provider = new TestProvider({ client: { client_id: 'desk' } });
    const { tokens } = await handshake(harness, provider);
    expect(tokens.access_token).toMatch(/^vg_at_/);
    expect(await mcpStatus(harness, tokens.access_token)).toBe(200);
  });

  it('OAUTH-25 refreshes through the SDK, rotating the refresh token', async () => {
    const harness = newHarness();
    const { provider, tokens } = await handshake(harness, new TestProvider({ cimd: true }));
    harness.advance(60_000);
    const result = await auth(provider, { serverUrl: RESOURCE, fetchFn: fetchThrough(harness) });
    expect(result).toBe('AUTHORIZED');
    const rotated = provider.tokens();
    expect(rotated?.refresh_token).not.toBe(tokens.refresh_token);
    expect(await mcpStatus(harness, rotated?.access_token)).toBe(200);
  });

  it('OAUTH-32 an expired access token is refused by /mcp while the refresh token still works', async () => {
    const harness = newHarness();
    const { provider, tokens } = await handshake(harness, new TestProvider({ cimd: true }));
    harness.advance(3_600_000);
    expect(await mcpStatus(harness, tokens.access_token)).toBe(401);
    const result = await auth(provider, { serverUrl: RESOURCE, fetchFn: fetchThrough(harness) });
    expect(result).toBe('AUTHORIZED');
    expect(await mcpStatus(harness, provider.tokens()?.access_token)).toBe(200);
  });
});
