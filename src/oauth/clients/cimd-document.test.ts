import { describe, expect, it } from 'vitest';

import { parseCimdDocument } from './cimd-document.ts';

const CLIENT_ID = 'https://agent.example.com/oauth/client.json';

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    client_id: CLIENT_ID,
    client_name: 'Agent',
    redirect_uris: ['https://agent.example.com/cb', 'http://127.0.0.1:1/cb'],
    ...overrides,
  };
}

describe('parseCimdDocument', () => {
  it('OAUTH-9 accepts the required fields and passes unknown fields through', () => {
    const parsed = parseCimdDocument(CLIENT_ID, document({ custom_field: { nested: true } }));
    expect(parsed).toStrictEqual({
      ok: true,
      document: {
        client_id: CLIENT_ID,
        client_name: 'Agent',
        redirect_uris: ['https://agent.example.com/cb', 'http://127.0.0.1:1/cb'],
        custom_field: { nested: true },
      },
    });
  });

  it('OAUTH-9 requires client_id to equal the document URL exactly', () => {
    expect(parseCimdDocument(`${CLIENT_ID}?v=2`, document())).toStrictEqual({
      ok: false,
      reason: 'client_id does not equal the document URL',
    });
  });

  it.each([
    [{ client_name: '' }, 'client_name'],
    [{ client_name: undefined }, 'client_name'],
    [{ redirect_uris: [] }, 'redirect_uris'],
    [{ redirect_uris: ['http://agent.example.com/cb'] }, 'redirect_uris.0'],
    [{ client_id: 'http://agent.example.com/client.json' }, 'client_id'],
    [{ token_endpoint_auth_method: 'client_secret_basic' }, 'token_endpoint_auth_method'],
    [{ grant_types: ['client_credentials'] }, 'grant_types.0'],
    [{ response_types: ['token'] }, 'response_types.0'],
    [{ application_type: 'desktop' }, 'application_type'],
    [{ logo_uri: 'http://agent.example.com/logo.png' }, 'logo_uri'],
  ])('OAUTH-9 rejects %j', (overrides, path) => {
    const parsed = parseCimdDocument(CLIENT_ID, document(overrides));
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).toContain(`"reason":"${path}:`);
  });

  it('OAUTH-9 rejects a non-object body', () => {
    expect(parseCimdDocument(CLIENT_ID, 'text').ok).toBe(false);
  });

  it('OAUTH-9 validates optional fields when present', () => {
    const parsed = parseCimdDocument(
      CLIENT_ID,
      document({
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        application_type: 'native',
        scope: 'vault:read',
        client_uri: 'https://agent.example.com',
        contacts: ['ops@example.com'],
        software_id: 'agent',
        software_version: '1.0',
      }),
    );
    expect(parsed.ok).toBe(true);
  });
});
