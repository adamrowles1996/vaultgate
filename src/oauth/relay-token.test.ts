import { describe, expect, it } from 'vitest';

import { SCOPES } from '../scopes/registry.ts';
import { openTestRepos, TEST_OPERATOR_ID } from '../test-support/oauth-store.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { HOUR_MS } from './clock.ts';
import { hashCredential } from './credentials.ts';
import { createRelayTokenIssuer, type IssueRelayToken } from './relay-token.ts';
import { StoreTokenVerifier } from './token-verifier.ts';

import type { AuditEvent } from '../audit/event.ts';

const PUBLIC_URL = 'https://vault.example.com';
const CLIENT_ID = 'https://client.example/metadata.json';
const NODE = { node: 'sandbox-1.example.ts.net', ip: '100.64.0.20' };
const CONSENT_SCOPES = ['vault:read', 'actions:sql.read'];

interface Setup {
  readonly issue: IssueRelayToken;
  readonly repos: ReturnType<typeof openTestRepos>;
  readonly audit: readonly AuditEvent[];
  readonly verifier: (publicUrl?: string) => StoreTokenVerifier;
  readonly advance: (ms: number) => void;
}

function setup(
  options: { client?: boolean; clientRevokedAt?: number; consent?: boolean } = {},
): Setup {
  const repos = openTestRepos();
  let at = 1_000_000;
  let ids = 0;
  if (options.client !== false) {
    repos.clients.upsert({
      id: 'c',
      clientId: CLIENT_ID,
      mode: 'cimd',
      clientName: 'Agent',
      redirectUris: ['https://client.example/cb'],
      metadata: {},
      createdAt: 0,
      revokedAt: options.clientRevokedAt,
    });
  }
  if (options.client !== false && options.consent !== false) {
    repos.consents.insert({
      id: 'consent-1',
      operatorId: TEST_OPERATOR_ID,
      clientId: CLIENT_ID,
      scopes: CONSENT_SCOPES,
      grantedAt: 0,
      revokedAt: undefined,
    });
  }
  const audit: AuditEvent[] = [];
  const issue = createRelayTokenIssuer({
    repos,
    publicUrl: PUBLIC_URL,
    clientId: CLIENT_ID,
    accessTokenTtlMs: HOUR_MS,
    audit: {
      record: (event) => {
        audit.push(event);
      },
    },
    now: () => at,
    random: (bytes) => Buffer.alloc(bytes, ids),
    newId: () => {
      ids += 1;
      return `id-${String(ids)}`;
    },
  });
  return {
    issue,
    repos,
    audit,
    verifier: (publicUrl = PUBLIC_URL) =>
      new StoreTokenVerifier({ publicUrl, repos, now: () => at }),
    advance: (ms) => {
      at += ms;
    },
  };
}

function issued(context: Setup): string {
  const result = context.issue(NODE);
  if (result === undefined) {
    throw new Error('expected a token');
  }
  return result.token.access_token;
}

describe('relay access tokens', () => {
  it('RELAY-14 issues one access token with every scope under the newest live consent, and no refresh token', () => {
    const context = setup();
    const result = context.issue(NODE);
    expect(result?.token).toStrictEqual({
      object: 'token',
      access_token: expect.stringMatching(/^vg_at_[\w-]{43}$/) as unknown,
      token_type: 'Bearer',
      expires_in: 3600,
      scope: SCOPES.join(' '),
      resource: `${PUBLIC_URL}/mcp`,
    });
    const token = result?.token.access_token ?? '';
    const stored = context.repos.tokens.findByHash(hashCredential(token));
    expect(stored).toMatchObject({
      kind: 'access',
      clientId: CLIENT_ID,
      consentId: 'consent-1',
      scopes: [...SCOPES],
      parentId: undefined,
      expiresAt: 1_000_000 + HOUR_MS,
    });
    expect(result?.tokenId).toBe(hashCredential(token).slice(0, 12));
    expect(context.repos.tokens.findByHash(token)).toBeUndefined();
  });

  it('RELAY-15 issues a token /mcp verifies as the configured client, with every registry scope', () => {
    const context = setup();
    const token = issued(context);
    expect(unwrapOk(context.verifier().verify(token))).toMatchObject({
      clientId: CLIENT_ID,
      subject: TEST_OPERATOR_ID,
      scopes: [...SCOPES],
      resource: `${PUBLIC_URL}/mcp`,
    });
    expect(issued(context)).not.toBe(token);
  });

  it('RELAY-17 keeps the admitted node on the token row, and /mcp sees it on the verified token', () => {
    const context = setup();
    const token = issued(context);
    expect(context.repos.tokens.findByHash(hashCredential(token))?.relayNode).toBe(NODE.node);
    expect(unwrapOk(context.verifier().verify(token)).relayNode).toBe(NODE.node);
  });

  it('RELAY-15 refuses to issue for an unknown or revoked client, or one with no live consent', () => {
    expect(setup({ client: false }).issue(NODE)).toBeUndefined();
    expect(setup({ clientRevokedAt: 5 }).issue(NODE)).toBeUndefined();
    expect(setup({ consent: false }).issue(NODE)).toBeUndefined();
    const revoked = setup();
    revoked.repos.consents.revoke('consent-1', 5);
    expect(revoked.issue(NODE)).toBeUndefined();
    expect(revoked.audit).toStrictEqual([]);
  });

  it('RELAY-15 a relay token fails once its consent is revoked, it is revoked, or it expires', () => {
    const context = setup();
    const second = issued(context);
    const third = issued(context);
    context.repos.tokens.revokeById(
      context.repos.tokens.findByHash(hashCredential(second))?.id ?? '',
      2,
    );
    expect(unwrapFail(context.verifier().verify(second)).reason).toBe('revoked');
    context.advance(HOUR_MS);
    expect(unwrapFail(context.verifier().verify(third)).reason).toBe('expired');
    const later = setup();
    const token = issued(later);
    later.repos.consents.revoke('consent-1', 5);
    expect(unwrapFail(later.verifier().verify(token)).reason).toBe('revoked');
  });

  it('RELAY-15 a relay token is refused by another deployment and cannot be extended', () => {
    const context = setup();
    const token = issued(context);
    expect(unwrapFail(context.verifier('https://other.example.com').verify(token))).toMatchObject({
      reason: 'unknown',
      message: 'token issued for another resource',
    });
    expect(unwrapFail(context.verifier().verify(`${token}x`)).reason).toBe('unknown');
    expect(unwrapFail(context.verifier().verify('vg_rt_relay')).reason).toBe('malformed');
  });

  it('RELAY-16 audits each issue with the client, the token prefix and the node, never the token', () => {
    const context = setup();
    const result = context.issue(NODE);
    expect(context.audit).toStrictEqual([
      {
        category: 'oauth',
        action: 'token_issued',
        outcome: 'ok',
        operatorId: TEST_OPERATOR_ID,
        clientId: CLIENT_ID,
        tokenPrefix: result?.tokenId,
        ip: NODE.ip,
        details: { via: 'relay', node: NODE.node },
      },
    ]);
    expect(JSON.stringify(context.audit)).not.toContain(result?.token.access_token ?? 'missing');
  });
});
