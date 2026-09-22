import { describe, expect, it } from 'vitest';

import { createLocalProvider, loginLocation, safeNextPath } from './provider.ts';

import type { SessionState } from './session-manager.ts';

const SESSION: SessionState = {
  idHash: 'h',
  operatorId: 'op-1',
  csrfToken: 't',
  createdAt: 0,
  expiresAt: 10,
  reauthenticatedAt: undefined,
  isReauthenticated: false,
};

describe('safeNextPath', () => {
  it('ID-14 keeps local paths and falls back for anything else', () => {
    expect(safeNextPath('/oauth/authorize/x?y=1')).toBe('/oauth/authorize/x?y=1');
    expect(safeNextPath(undefined)).toBe('/account');
    expect(safeNextPath('https://evil.example')).toBe('/account');
    expect(safeNextPath('//evil.example')).toBe('/account');
    expect(safeNextPath(String.raw`/\evil.example`, '/x')).toBe('/x');
  });
});

describe('createLocalProvider', () => {
  it('ID-21 yields the operator id for a session and a login redirect without one', async () => {
    const provider = createLocalProvider();
    const request = new Request('https://vault.example.com/oauth/authorize?client_id=a');
    const authenticated = await provider.authenticate(request, SESSION);
    const redirected = await provider.authenticate(request, undefined);
    expect(provider.kind).toBe('local');
    expect(authenticated).toStrictEqual({ kind: 'authenticated', operatorId: 'op-1' });
    expect(redirected).toStrictEqual({
      kind: 'redirect',
      location: '/login?next=%2Foauth%2Fauthorize%3Fclient_id%3Da',
    });
    expect(loginLocation(request)).toBe('/login?next=%2Foauth%2Fauthorize%3Fclient_id%3Da');
  });
});
