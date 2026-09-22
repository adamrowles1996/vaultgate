/**
 * Fixtures for the token endpoint tests: a seeded client, consent and
 * authorization code (RFC 7636 Appendix B challenge), plus form builders.
 */
import { expect } from 'vitest';

import { CREDENTIAL_PREFIX, hashCredential, mintCredential } from '../oauth/credentials.ts';

import {
  createOAuthHarness,
  type Exchange,
  type OAuthHarness,
  OPERATOR_ID,
  RESOURCE,
} from './oauth-harness.ts';
import { formBody, parseJson } from './oauth-http.ts';

export const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
export const CLIENT_ID = 'vg_c_test-client';
const REDIRECT = 'https://agent.example.com/cb';
export const DAY_MS = 86_400_000;

export interface SeedOptions {
  readonly expiresIn?: number;
  readonly consentRevokedAt?: number;
}

export interface Seeded {
  readonly harness: OAuthHarness;
  readonly code: string;
}

export interface TokenReply {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
}

export const counters = { code: 0, id: 0 };

function seed(harness: OAuthHarness, options: SeedOptions = {}): string {
  const at = harness.now();
  harness.ensureOperator();
  harness.repos.clients.upsert({
    id: 'client-row',
    clientId: CLIENT_ID,
    mode: 'dcr',
    clientName: 'Agent',
    redirectUris: [REDIRECT],
    metadata: {},
    createdAt: at,
    revokedAt: undefined,
  });
  if (harness.repos.consents.findById('consent-1') === undefined) {
    harness.repos.consents.insert({
      id: 'consent-1',
      operatorId: OPERATOR_ID,
      clientId: CLIENT_ID,
      scopes: ['vault:read', 'vault:reveal'],
      grantedAt: at,
      revokedAt: options.consentRevokedAt,
    });
  }
  counters.code += 1;
  const code = mintCredential(CREDENTIAL_PREFIX.authorizationCode, (bytes) => {
    const buffer = Buffer.alloc(bytes);
    buffer.writeUInt32BE(counters.code, 0);
    return buffer;
  });
  harness.repos.authorizationCodes.insert({
    codeHash: hashCredential(code),
    clientId: CLIENT_ID,
    consentId: 'consent-1',
    redirectUri: REDIRECT,
    codeChallenge: CHALLENGE,
    resource: RESOURCE,
    scopes: ['vault:read', 'vault:reveal'],
    expiresAt: at + (options.expiresIn ?? 300_000),
    usedAt: undefined,
  });
  return code;
}

export function seeded(options: SeedOptions = {}): Seeded {
  const harness = createOAuthHarness();
  return { harness, code: seed(harness, options) };
}

export function codeGrant(
  code: string,
  overrides: Record<string, string | undefined> = {},
): Record<string, string> {
  const fields: Record<string, string | undefined> = {
    grant_type: 'authorization_code',
    code,
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: RESOURCE,
    ...overrides,
  };
  return Object.fromEntries(
    Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

export function refreshGrant(
  refreshToken: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
    ...extra,
  };
}

export async function post(
  harness: OAuthHarness,
  fields: Record<string, string>,
): Promise<TokenReply> {
  const exchange: Exchange = await harness.exchange('/oauth/token', formBody(fields));
  return { status: exchange.status, headers: exchange.headers, body: parseJson(exchange) };
}

export async function errorOf(
  harness: OAuthHarness,
  fields: Record<string, string>,
): Promise<Record<string, unknown>> {
  const reply = await post(harness, fields);
  return reply.body;
}

export async function redeem(harness: OAuthHarness, code: string): Promise<Record<string, string>> {
  const reply = await post(harness, codeGrant(code));
  expect(reply.status).toBe(200);
  return Object.fromEntries(Object.entries(reply.body).map(([key, value]) => [key, String(value)]));
}

export function revokedAt(harness: OAuthHarness, token: string): number | undefined {
  return harness.repos.tokens.findByHash(hashCredential(token))?.revokedAt;
}

export function claimKind(harness: OAuthHarness, code: string): string {
  return harness.repos.authorizationCodes.claim(hashCredential(code), 0).kind;
}
