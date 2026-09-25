import { describe, expect, it } from 'vitest';

import { ACTIONS_OFF } from '../../test-support/actions-config.ts';
import { openTestRepos } from '../../test-support/oauth-store.ts';
import { unwrapFail, unwrapOk } from '../../test-support/result.ts';

import {
  type DynamicRegistrationOptions,
  type RegistrationResponse,
  registerDynamicClient,
} from './dynamic.ts';

import type { OAuthError } from '../errors.ts';

type Options = DynamicRegistrationOptions & { readonly repos: ReturnType<typeof openTestRepos> };

function options(canWrite = false): Options {
  const repos = openTestRepos();
  return {
    repos,
    clients: repos.clients,
    now: () => 1_700_000_000_500,
    random: (bytes) => Buffer.alloc(bytes, 1),
    newId: () => 'row-1',
    enableWriteScope: canWrite,
    actions: ACTIONS_OFF,
  };
}

function errorFor(body: unknown, canWrite = false): OAuthError {
  const result = registerDynamicClient(body, options(canWrite));
  return unwrapFail(result);
}

function responseFor(body: unknown, canWrite = false): RegistrationResponse {
  const result = registerDynamicClient(body, options(canWrite));
  return unwrapOk(result);
}

const MINIMAL = { redirect_uris: ['https://app.example.com/cb'] };

describe('registerDynamicClient', () => {
  it('OAUTH-11 mints a vg_c_ id, echoes the metadata and stores the client', () => {
    const dependencies = options();
    const result = registerDynamicClient(
      { ...MINIMAL, client_name: ' Agent ', scope: 'vault:read', ignored: 1 },
      dependencies,
    );
    const response = unwrapOk(result);
    expect(response).toStrictEqual({
      client_id: `vg_c_${Buffer.alloc(32, 1).toString('base64url')}`,
      client_id_issued_at: 1_700_000_000,
      redirect_uris: ['https://app.example.com/cb'],
      client_name: 'Agent',
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
      scope: 'vault:read',
    });
    expect(JSON.stringify(response)).not.toContain('client_secret');
    expect(dependencies.repos.clients.findByClientId(response.client_id)).toStrictEqual({
      id: 'row-1',
      clientId: response.client_id,
      mode: 'dcr',
      clientName: 'Agent',
      redirectUris: ['https://app.example.com/cb'],
      metadata: response,
      createdAt: 1_700_000_000_500,
      revokedAt: undefined,
    });
  });

  it('OAUTH-5 rejects confidential authentication methods with invalid_client_metadata', () => {
    const error = errorFor({ ...MINIMAL, token_endpoint_auth_method: 'client_secret_basic' });
    expect(error.code).toBe('invalid_client_metadata');
    expect(error.description).toContain('token_endpoint_auth_method must be "none"');
  });

  it('OAUTH-6 rejects a bad redirect URI with invalid_redirect_uri', () => {
    expect(errorFor({ redirect_uris: ['http://app.example.com/cb'] }).code).toBe(
      'invalid_redirect_uri',
    );
    expect(errorFor({ redirect_uris: [] }).code).toBe('invalid_redirect_uri');
    expect(errorFor({}).code).toBe('invalid_redirect_uri');
  });

  it.each([
    [{ grant_types: ['client_credentials'] }, 'grant_types'],
    [{ grant_types: [] }, 'grant_types'],
    [{ response_types: ['token'] }, 'response_types.0'],
    [{ application_type: 'desktop' }, 'application_type'],
    [{ client_name: '' }, 'client_name'],
  ])('OAUTH-11 rejects %j with invalid_client_metadata', (extra, path) => {
    const error = errorFor({ ...MINIMAL, ...extra });
    expect(error.code).toBe('invalid_client_metadata');
    expect(error.description.startsWith(`${path}:`)).toBe(true);
  });

  it('OAUTH-11 rejects a non-object body', () => {
    expect(errorFor('text').description).toBe('the body must be a JSON object');
    expect(errorFor(null).code).toBe('invalid_client_metadata');
  });

  it('OAUTH-16 rejects unknown scopes and vault:write while it is disabled', () => {
    expect(errorFor({ ...MINIMAL, scope: 'vault:read vault:admin' }).description).toBe(
      'scope "vault:admin" is not available',
    );
    expect(errorFor({ ...MINIMAL, scope: 'vault:write' }).description).toBe(
      'scope "vault:write" is not available',
    );
    expect(responseFor({ ...MINIMAL, scope: 'vault:write' }, true).scope).toBe('vault:write');
    expect(responseFor({ ...MINIMAL, scope: '' }).scope).toBe('');
  });

  it('OAUTH-11 accepts explicit valid values', () => {
    const response = responseFor({
      ...MINIMAL,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'],
      response_types: ['code'],
      application_type: 'native',
    });
    expect(response.grant_types).toStrictEqual(['authorization_code']);
    expect(response.application_type).toBe('native');
    expect(response.client_name).toBeUndefined();
  });
});
