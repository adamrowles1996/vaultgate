import { describe, expect, it } from 'vitest';

import { isSecretLookingName } from './secret-names.ts';

describe('isSecretLookingName', () => {
  it.each([
    'Secret Value',
    'secret',
    'Password',
    'DB_PASSWD',
    'pwd',
    'dbPwd',
    'Token',
    'access_token',
    'API Key',
    'api_key',
    'apiKey',
    'ApiKey',
    'X-API-KEY',
    'Client Secret',
    'client_secret',
    'clientSecret',
    'PAT',
    'GitHub PAT',
    'private',
    'Private Key',
    'Credentials',
    'Connection String',
    'connection_string',
    'ConnectionString',
    'conn',
    'Conn Str',
    'AccessKey',
    'ssh-key',
    'Keys',
  ])('MCP-18 treats %j as secret-looking', (name) => {
    expect(isSecretLookingName(name)).toBe(true);
  });

  it.each([
    'username',
    'Username',
    'host',
    'Hostname',
    'Port',
    'Tenant ID',
    'client_id',
    'Database',
    'Environment',
    'path',
    'Pattern',
    'Connector',
    'Connection name',
    'monkey',
    'Keyboard',
    'URL',
    '',
  ])('MCP-18 leaves %j readable', (name) => {
    expect(isSecretLookingName(name)).toBe(false);
  });
});
