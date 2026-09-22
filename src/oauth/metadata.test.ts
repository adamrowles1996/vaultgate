import { describe, expect, it } from 'vitest';

import { authorizationServerMetadata, canonicalResource, METADATA_HEADERS } from './metadata.ts';

describe('authorizationServerMetadata', () => {
  it('OAUTH-2 contains every required field', () => {
    expect(
      authorizationServerMetadata({
        publicUrl: 'https://vault.example.com',
        enableWriteScope: true,
      }),
    ).toStrictEqual({
      issuer: 'https://vault.example.com',
      authorization_endpoint: 'https://vault.example.com/oauth/authorize',
      token_endpoint: 'https://vault.example.com/oauth/token',
      revocation_endpoint: 'https://vault.example.com/oauth/revoke',
      registration_endpoint: 'https://vault.example.com/oauth/register',
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['vault:read', 'vault:reveal', 'vault:write', 'vault:generate'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
  });

  it('OAUTH-16 advertises only the scopes this deployment grants', () => {
    const document = authorizationServerMetadata({
      publicUrl: 'https://vault.example.com',
      enableWriteScope: false,
    });
    expect(document.scopes_supported).toStrictEqual([
      'vault:read',
      'vault:reveal',
      'vault:generate',
    ]);
  });

  it('OAUTH-4 never advertises offline_access', () => {
    const document = authorizationServerMetadata({
      publicUrl: 'https://vault.example.com',
      enableWriteScope: true,
    });
    expect(JSON.stringify(document)).not.toContain('offline_access');
  });

  it('OAUTH-3 headers are JSON, five-minute public cache and permissive CORS', () => {
    expect(METADATA_HEADERS).toStrictEqual({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    });
  });
});

describe('canonicalResource', () => {
  it('§3.1 is the public URL plus /mcp without a trailing slash', () => {
    expect(canonicalResource('https://vault.example.com')).toBe('https://vault.example.com/mcp');
  });
});
