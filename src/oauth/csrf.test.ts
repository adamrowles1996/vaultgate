import { describe, expect, it } from 'vitest';

import { createCsrfGuard } from './csrf.ts';

const session = { operatorId: 'op', sessionKey: 'key', csrfToken: 'token-1' };
const guard = createCsrfGuard('https://vault.example.com');

function isTrusted(headers: Record<string, string>, formToken: string | undefined): boolean {
  return guard.isTrusted({
    request: new Request('https://vault.example.com/oauth/authorize', { method: 'POST', headers }),
    session,
    formToken,
  });
}

describe('createCsrfGuard', () => {
  it('ID-18 accepts a same-origin request carrying the session token', () => {
    expect(isTrusted({ origin: 'https://vault.example.com' }, 'token-1')).toBe(true);
    expect(isTrusted({ 'sec-fetch-site': 'same-origin' }, 'token-1')).toBe(true);
  });

  it('ID-18 rejects a foreign origin', () => {
    expect(isTrusted({ origin: 'https://evil.example.com' }, 'token-1')).toBe(false);
  });

  it('ID-18 rejects a request without origin proof', () => {
    expect(isTrusted({}, 'token-1')).toBe(false);
    expect(isTrusted({ 'sec-fetch-site': 'cross-site' }, 'token-1')).toBe(false);
  });

  it('ID-18 rejects a missing or wrong synchroniser token', () => {
    expect(isTrusted({ origin: 'https://vault.example.com' }, undefined)).toBe(false);
    expect(isTrusted({ origin: 'https://vault.example.com' }, 'token-2')).toBe(false);
  });
});
