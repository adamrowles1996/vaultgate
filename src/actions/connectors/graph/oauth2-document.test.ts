import { describe, expect, it } from 'vitest';

import { graphCredential } from '../../../test-support/graph.ts';
import {
  OAUTH2_CLIENT,
  OAUTH2_TOKEN_HOST,
  OAUTH2_TOKEN_URL,
  oauth2Credential,
} from '../../../test-support/oauth2.ts';

import {
  adapterCredentialFields,
  oauth2CredentialSchema,
  oauth2TokenEndpoint,
} from './oauth2-document.ts';

const BASE = {
  mode: 'oauth2',
  token_url: OAUTH2_TOKEN_URL,
  grant: 'client_credentials',
  client_id: OAUTH2_CLIENT,
  secret_field: 'custom.client-secret',
};

function messagesFor(overrides: Readonly<Record<string, unknown>>): readonly string[] {
  const parsed = oauth2CredentialSchema.safeParse({ ...BASE, ...overrides });
  return parsed.error?.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) ?? [];
}

describe('the oauth2 adapter document', () => {
  it('ACT-124 applies the defaults: client authentication in the form, the token in Authorization as a Bearer, no scope', () => {
    expect(oauth2CredentialSchema.parse(BASE)).toStrictEqual({
      ...BASE,
      client_auth: 'post',
      name: 'authorization',
      prefix: 'Bearer ',
    });
  });

  it('ACT-124 keeps a scope, Basic client authentication, a header of its own and a prefix with its space', () => {
    const zoho = oauth2CredentialSchema.parse({
      ...BASE,
      grant: 'refresh_token',
      refresh_token_field: 'custom.refresh',
      prefix: 'Zoho-oauthtoken ',
    });
    expect(zoho).toMatchObject({ name: 'authorization', prefix: 'Zoho-oauthtoken ' });
    expect(zoho.scope).toBeUndefined();
    const custom = oauth2CredentialSchema.parse({
      ...BASE,
      scope: 'https://analysis.windows.net/powerbi/api/.default',
      client_auth: 'basic',
      name: 'X-Access-Token',
      prefix: '',
    });
    expect(custom).toMatchObject({
      scope: 'https://analysis.windows.net/powerbi/api/.default',
      client_auth: 'basic',
      name: 'x-access-token',
      prefix: '',
    });
  });

  it('ACT-124 takes an https token URL only, even for an internal target, with no query, fragment or credentials', () => {
    expect(
      oauth2CredentialSchema.safeParse({ ...BASE, token_url: 'https://[2001:db8::1]:8443/t' })
        .success,
    ).toBe(true);
    const refused = [
      ['not a url', 'must be an absolute URL'],
      [
        'http://auth.example.com/token',
        'must be an https:// URL, even on an internal target: the client secret is sent to it',
      ],
      [
        'ftp://auth.example.com/token',
        'must be an https:// URL, even on an internal target: the client secret is sent to it',
      ],
      ['https://auth.example.com/token?realm=a', 'must not carry a query string or fragment'],
      ['https://auth.example.com/token?', 'must not carry a query string or fragment'],
      ['https://auth.example.com/token#top', 'must not carry a query string or fragment'],
      ['https://auth.example.com/token#', 'must not carry a query string or fragment'],
      ['https://client:secret@auth.example.com/token', 'must not carry credentials'],
      ['https://client@auth.example.com/token', 'must not carry credentials'],
    ] as const;
    for (const [tokenUrl, message] of refused) {
      expect(messagesFor({ token_url: tokenUrl })).toStrictEqual([`token_url: ${message}`]);
    }
  });

  it('ACT-124 takes a client id of 1 to 512 printable characters without spaces, and refuses a mode it does not know', () => {
    for (const clientId of [
      '1000.ABCDEF',
      '11111111-2222-3333-4444-555555555555',
      'x'.repeat(512),
    ]) {
      expect(oauth2CredentialSchema.safeParse({ ...BASE, client_id: clientId }).success).toBe(true);
    }
    for (const clientId of ['', 'a b', 'tab\there', 'é', 'x'.repeat(513), 'line\nbreak']) {
      expect(messagesFor({ client_id: clientId })).toStrictEqual([
        'client_id: must be 1 to 512 printable characters, no spaces',
      ]);
    }
    expect(messagesFor({ client_auth: 'jwt' })).toHaveLength(1);
    expect(messagesFor({ grant: 'password' })).toHaveLength(1);
    expect(messagesFor({ name: 'bad header' })).toStrictEqual([
      'name: must be an HTTP header name',
    ]);
    expect(messagesFor({ extra: true })).toHaveLength(1);
    expect(messagesFor({ scope: '' })).toHaveLength(1);
    expect(messagesFor({ secret_field: '' })).toHaveLength(1);
  });

  it('ACT-124 requires refresh_token_field for the refresh_token grant and refuses it for client_credentials, which never uses it', () => {
    expect(messagesFor({ grant: 'refresh_token' })).toStrictEqual([
      ': refresh_token_field is required for the refresh_token grant',
    ]);
    expect(messagesFor({ refresh_token_field: 'custom.refresh' })).toStrictEqual([
      ': refresh_token_field is used by the refresh_token grant only; remove it',
    ]);
    expect(
      messagesFor({ grant: 'refresh_token', refresh_token_field: 'custom.refresh' }),
    ).toStrictEqual([]);
  });

  it('ACT-4 ACT-124 names the client secret, and the refresh token when the mapping has one, for graph and oauth2 alike', () => {
    const secret = { name: 'password', selector: 'password', role: 'secret' };
    const refresh = { name: 'custom.refresh', selector: 'custom.refresh', role: 'secret' };
    expect(adapterCredentialFields(oauth2Credential())).toStrictEqual([secret]);
    expect(adapterCredentialFields(graphCredential())).toStrictEqual([secret]);
    expect(
      adapterCredentialFields(
        oauth2Credential({ grant: 'refresh_token', refresh_token_field: 'custom.refresh' }),
      ),
    ).toStrictEqual([secret, refresh]);
    expect(
      adapterCredentialFields(
        graphCredential({ grant: 'refresh_token', refresh_token_field: 'custom.refresh' }),
      ),
    ).toStrictEqual([secret, refresh]);
  });

  it('ACT-124 ACT-125 names the token endpoint host, port left out, as an encrypted endpoint', () => {
    expect(oauth2TokenEndpoint(oauth2Credential())).toStrictEqual({
      host: OAUTH2_TOKEN_HOST,
      tls: true,
    });
    expect(oauth2TokenEndpoint({ token_url: 'https://[2001:db8::1]:8443/token' })).toStrictEqual({
      host: '[2001:db8::1]',
      tls: true,
    });
  });
});
