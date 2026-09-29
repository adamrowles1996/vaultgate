import { describe, expect, it } from 'vitest';

import { GRAPH_CLIENT, graphCredential, TOKEN_URL } from '../../../test-support/graph.ts';
import {
  OAUTH2_CLIENT,
  OAUTH2_TOKEN_HOST,
  OAUTH2_TOKEN_URL,
  oauth2Credential,
  oauth2RefreshCredential,
} from '../../../test-support/oauth2.ts';

import {
  exchangePlan,
  GRAPH_ACCESS_TOKEN_FIELD,
  graphTokenUrl,
  OAUTH2_ACCESS_TOKEN_FIELD,
} from './exchange.ts';

describe('the exchange plan of each adapter mode', () => {
  it('ACT-130 ACT-82 graph is the Microsoft Graph preset: the tenant token URL, the secret in the form, Authorization: Bearer', () => {
    expect(exchangePlan(graphCredential())).toStrictEqual({
      url: TOKEN_URL,
      host: 'login.microsoftonline.com',
      grant: 'client_credentials',
      clientId: GRAPH_CLIENT,
      clientAuth: 'post',
      scope: 'https://graph.microsoft.com/.default',
      secretField: 'password',
      refreshTokenField: undefined,
      accessTokenField: GRAPH_ACCESS_TOKEN_FIELD,
      header: { name: 'authorization', prefix: 'Bearer ' },
    });
    expect(GRAPH_ACCESS_TOKEN_FIELD).toBe('graph.access_token');
  });

  it('ACT-82 escapes the tenant into the path', () => {
    expect(graphTokenUrl('contoso.onmicrosoft.com')).toBe(TOKEN_URL);
    expect(graphTokenUrl('a/b')).toBe('https://login.microsoftonline.com/a%2Fb/oauth2/v2.0/token');
  });

  it('ACT-125 ACT-128 oauth2 takes every part from its document, the token redacted as oauth2.access_token', () => {
    expect(exchangePlan(oauth2Credential())).toStrictEqual({
      url: OAUTH2_TOKEN_URL,
      host: OAUTH2_TOKEN_HOST,
      grant: 'client_credentials',
      clientId: OAUTH2_CLIENT,
      clientAuth: 'post',
      scope: undefined,
      secretField: 'password',
      refreshTokenField: undefined,
      accessTokenField: OAUTH2_ACCESS_TOKEN_FIELD,
      header: { name: 'authorization', prefix: 'Bearer ' },
    });
    expect(OAUTH2_ACCESS_TOKEN_FIELD).toBe('oauth2.access_token');
    const zoho = exchangePlan(
      oauth2RefreshCredential({
        token_url: 'https://accounts.example.com:8443/oauth/v2/token',
        client_auth: 'basic',
        scope: 'ZohoBooks.invoices.READ',
        name: 'X-Token',
        prefix: 'Zoho-oauthtoken ',
      }),
    );
    expect(zoho).toMatchObject({
      url: 'https://accounts.example.com:8443/oauth/v2/token',
      host: 'accounts.example.com',
      grant: 'refresh_token',
      clientAuth: 'basic',
      scope: 'ZohoBooks.invoices.READ',
      refreshTokenField: 'custom.refresh',
      header: { name: 'x-token', prefix: 'Zoho-oauthtoken ' },
    });
  });
});
