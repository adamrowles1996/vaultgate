import { describe, expect, it } from 'vitest';

import {
  forbiddenResponse,
  insufficientScopeChallenge,
  invalidTokenChallenge,
  missingTokenChallenge,
  unauthorizedResponse,
} from './challenges.ts';

const METADATA = 'https://vault.example.com/.well-known/oauth-protected-resource/mcp';

describe('challenges', () => {
  it('§2.3.1 builds the first-contact challenge byte-exactly', () => {
    expect(missingTokenChallenge(METADATA)).toBe(
      `Bearer resource_metadata="${METADATA}", scope="vault:read"`,
    );
  });

  it('OAUTH-32 builds the invalid_token challenge byte-exactly', () => {
    expect(invalidTokenChallenge(METADATA)).toBe(
      `Bearer error="invalid_token", resource_metadata="${METADATA}", scope="vault:read"`,
    );
  });

  it('OAUTH-33 lists every required scope in one insufficient_scope challenge', () => {
    expect(
      insufficientScopeChallenge(
        METADATA,
        ['vault:write', 'vault:reveal'],
        'update_item requires vault:write vault:reveal',
      ),
    ).toBe(
      `Bearer error="insufficient_scope", scope="vault:write vault:reveal", resource_metadata="${METADATA}", error_description="update_item requires vault:write vault:reveal"`,
    );
  });

  it('OAUTH-4 never mentions offline_access', () => {
    expect(missingTokenChallenge(METADATA)).not.toContain('offline_access');
    expect(invalidTokenChallenge(METADATA)).not.toContain('offline_access');
    expect(insufficientScopeChallenge(METADATA, ['vault:read'], 'x')).not.toContain(
      'offline_access',
    );
  });

  it('OAUTH-32 answers 401 with the challenge header, an OAuth error body and no caching', async () => {
    const response = unauthorizedResponse(invalidTokenChallenge(METADATA), 'token expired');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(invalidTokenChallenge(METADATA));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toStrictEqual({
      error: 'invalid_token',
      error_description: 'token expired',
    });
  });

  it('OAUTH-33 answers 403 with the challenge header and the scopes in the body', async () => {
    const challenge = insufficientScopeChallenge(
      METADATA,
      ['vault:reveal'],
      'get_secret requires vault:reveal',
    );
    const response = forbiddenResponse(
      challenge,
      ['vault:reveal'],
      'get_secret requires vault:reveal',
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toBe(challenge);
    expect(await response.json()).toStrictEqual({
      error: 'insufficient_scope',
      scope: 'vault:reveal',
      error_description: 'get_secret requires vault:reveal',
    });
  });
});
