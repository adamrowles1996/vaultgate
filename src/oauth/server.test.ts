import { describe, expect, it } from 'vitest';

import { createOAuthHarness, OPERATOR_ID } from '../test-support/oauth-harness.ts';
import { unwrapFail } from '../test-support/result.ts';

import { createAuthorizationServer } from './server.ts';

import type { DatabaseSync } from 'node:sqlite';

const noop = (): undefined => undefined;

describe('createAuthorizationServer', () => {
  it('OAUTH-12 fails on an invalid pre-registered client list', () => {
    const result = createAuthorizationServer({
      config: {
        publicUrl: 'https://vault.example.com',
        enableWriteScope: false,
        oauthClients: [
          { clientId: 'bad', clientName: undefined, redirectUris: ['http://evil.example.com/cb'] },
        ],
        accessTokenTtlMs: 1,
        refreshTokenTtlMs: 1,
        trustProxy: false,
      },
      db: {} as DatabaseSync,
      sessions: { resolve: () => Promise.resolve(undefined) },
      audit: { record: noop },
      logger: { warn: noop },
      fetch: () => Promise.reject(new Error('unused')),
      lookup: () => Promise.resolve([]),
      now: () => 0,
      random: (bytes) => Buffer.alloc(bytes),
      newId: () => 'x',
      socketAddress: noop,
    });
    expect(unwrapFail(result).issues).toStrictEqual([
      'client "bad": redirect URI "http://evil.example.com/cb" must use https or a loopback http address',
    ]);
  });

  it('OAUTH-12 persists valid pre-registered clients at start-up', () => {
    const harness = createOAuthHarness({
      oauthClients: [
        { clientId: 'desk', clientName: 'Desk', redirectUris: ['https://desk.example.com/cb'] },
      ],
    });
    expect(harness.repos.clients.findByClientId('desk')).toMatchObject({
      mode: 'preregistered',
      clientName: 'Desk',
    });
  });

  it('OAUTH-30 exposes consent revocation and the connected-client list for the account page', () => {
    const harness = createOAuthHarness();
    harness.repos.clients.upsert({
      id: 'c',
      clientId: 'vg_c_x',
      mode: 'dcr',
      clientName: 'X',
      redirectUris: ['https://x.example/cb'],
      metadata: {},
      createdAt: 0,
      revokedAt: undefined,
    });
    harness.repos.consents.insert({
      id: 'consent-1',
      operatorId: OPERATOR_ID,
      clientId: 'vg_c_x',
      scopes: ['vault:read'],
      grantedAt: 1,
      revokedAt: undefined,
    });
    const connected = harness.server.listConnectedClients(OPERATOR_ID);
    expect(connected.map((client) => client.id)).toStrictEqual(['consent-1']);
    expect(harness.server.revokeConsent('someone-else', 'consent-1')).toBeUndefined();
    expect(harness.server.revokeConsent(OPERATOR_ID, 'consent-1')).toBe(0);
    expect(harness.server.revokeConsent(OPERATOR_ID, 'consent-1')).toBeUndefined();
    expect(harness.server.listConnectedClients(OPERATOR_ID)).toStrictEqual([]);
    expect(harness.audit.at(-1)).toMatchObject({
      action: 'consent_revoked',
      operatorId: OPERATOR_ID,
      clientId: 'vg_c_x',
    });
  });
});
