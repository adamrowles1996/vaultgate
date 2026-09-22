import { describe, expect, it } from 'vitest';

import { testConfig } from '../test-support/test-app.ts';

import { checkHost, checkOrigin, hasQueryStringToken, resolveSourceIp } from './request-guards.ts';

const URL_MCP = 'https://vault.example.com/mcp';

function requestWith(headers: Record<string, string>, url = URL_MCP): Request {
  return new Request(url, { method: 'POST', headers });
}

describe('request guards', () => {
  it('MCP-3 accepts a missing Origin, the public origin and a configured extra origin', () => {
    const config = testConfig({ VAULTGATE_ALLOWED_ORIGINS: 'https://agent.example' });
    expect(checkOrigin(new Headers(), config)).toStrictEqual({ ok: true });
    expect(checkOrigin(new Headers({ origin: 'https://vault.example.com' }), config)).toStrictEqual(
      { ok: true },
    );
    expect(checkOrigin(new Headers({ origin: 'https://agent.example' }), config)).toStrictEqual({
      ok: true,
    });
  });

  it('MCP-3 rejects any other Origin, including null and a different port', () => {
    const config = testConfig();
    expect(checkOrigin(new Headers({ origin: 'null' }), config)).toStrictEqual({
      ok: false,
      reason: 'origin not allowed',
    });
    expect(checkOrigin(new Headers({ origin: 'https://vault.example.com:8443' }), config).ok).toBe(
      false,
    );
    expect(checkOrigin(new Headers({ origin: 'https://evil.example' }), config).ok).toBe(false);
  });

  it('MCP-3 requires Host to match the public URL host, case-insensitively', () => {
    const config = testConfig();
    expect(checkHost(requestWith({ host: 'vault.example.com' }), config)).toStrictEqual({
      ok: true,
    });
    expect(checkHost(requestWith({ host: 'VAULT.example.com' }), config)).toStrictEqual({
      ok: true,
    });
    expect(checkHost(requestWith({ host: 'localhost:8080' }), config)).toStrictEqual({
      ok: false,
      reason: 'host does not match the public URL',
    });
  });

  it('MCP-3 falls back to the request URL host when no Host header is present', () => {
    const config = testConfig();
    expect(checkHost(new Request(URL_MCP), config)).toStrictEqual({ ok: true });
    expect(checkHost(new Request('https://other.example/mcp'), config).ok).toBe(false);
  });

  it('MCP-3 ignores X-Forwarded-Host unless the proxy is trusted', () => {
    const headers = { host: 'internal:8080', 'x-forwarded-host': 'vault.example.com, cdn.example' };
    expect(checkHost(requestWith(headers), testConfig()).ok).toBe(false);
    expect(checkHost(requestWith(headers), testConfig({ VAULTGATE_TRUST_PROXY: 'true' })).ok).toBe(
      true,
    );
    expect(
      checkHost(
        requestWith({ host: 'vault.example.com', 'x-forwarded-host': '' }),
        testConfig({ VAULTGATE_TRUST_PROXY: 'true' }),
      ).ok,
    ).toBe(true);
    expect(
      checkHost(
        requestWith({ host: 'vault.example.com', 'x-forwarded-host': 'evil.example' }),
        testConfig({ VAULTGATE_TRUST_PROXY: 'true' }),
      ).ok,
    ).toBe(false);
  });

  it('OAUTH-31 spots a token in the query string', () => {
    expect(hasQueryStringToken(`${URL_MCP}?access_token=vg_at_x`)).toBe(true);
    expect(hasQueryStringToken(`${URL_MCP}?foo=bar`)).toBe(false);
  });

  it('OPS-6 reports the socket address, or unknown when no socket is bound', () => {
    const config = testConfig();
    const bindings = { incoming: { socket: { remoteAddress: '10.0.0.7' } } };
    expect(resolveSourceIp(requestWith({ 'x-forwarded-for': '1.2.3.4' }), bindings, config)).toBe(
      '10.0.0.7',
    );
    expect(resolveSourceIp(requestWith({}), undefined, config)).toBe('unknown');
  });

  it('OPS-6 honours the first X-Forwarded-For entry only behind a trusted proxy', () => {
    const config = testConfig({ VAULTGATE_TRUST_PROXY: 'true' });
    const bindings = { incoming: { socket: { remoteAddress: '10.0.0.7' } } };
    expect(
      resolveSourceIp(requestWith({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }), bindings, config),
    ).toBe('1.2.3.4');
    expect(resolveSourceIp(requestWith({}), bindings, config)).toBe('10.0.0.7');
  });
});
