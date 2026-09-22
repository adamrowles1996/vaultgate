import { describe, expect, it } from 'vitest';

import {
  bitwardenServerSchema,
  booleanSchema,
  decodeSecretKey,
  normalisePublicUrl,
  originListSchema,
  preregisteredClientsSchema,
  publicUrlSchema,
  secretKeySchema,
  toOrigin,
} from './primitives.ts';

describe('booleanSchema', () => {
  it.each([
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
    [undefined, false],
  ])('maps %j', (input, expected) => {
    expect(booleanSchema('false').parse(input)).toBe(expected);
  });

  it('uses the given fallback', () => {
    expect(booleanSchema('true').parse(undefined)).toBe(true);
  });

  it('rejects other spellings', () => {
    expect(booleanSchema('false').safeParse('yes').success).toBe(false);
  });
});

describe('toOrigin', () => {
  it('accepts a bare origin and normalises it', () => {
    expect(toOrigin('HTTPS://App.Example.com:8443')).toBe('https://app.example.com:8443');
  });

  it.each(['ftp://x', 'not a url', 'https://x/path', 'https://x/?q', 'https://x/#f'])(
    'rejects %s',
    (text) => {
      expect(toOrigin(text)).toBeUndefined();
    },
  );
});

describe('originListSchema', () => {
  it('parses a comma-separated list, ignoring blanks', () => {
    expect(originListSchema.parse(' https://a.example, ,https://b.example ')).toStrictEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });

  it('defaults to an empty list', () => {
    expect(originListSchema.parse(undefined)).toStrictEqual([]);
  });

  it('names the offending entry', () => {
    const result = originListSchema.safeParse('https://ok.example,https://bad.example/path');
    expect(result.error?.issues[0]?.message).toBe(
      '"https://bad.example/path" is not an origin such as https://app.example.com',
    );
  });
});

describe('normalisePublicUrl and publicUrlSchema', () => {
  it('keeps a path but strips trailing slashes', () => {
    expect(normalisePublicUrl('https://vault.example.com/base//')).toBe(
      'https://vault.example.com/base',
    );
    expect(publicUrlSchema.parse('https://vault.example.com/')).toBe('https://vault.example.com');
  });

  it.each([
    'http://localhost:8080',
    'http://127.0.0.1',
    'http://[::1]:3000',
    'https://dev.localhost',
  ])('allows plain http for loopback %s', (text) => {
    expect(typeof normalisePublicUrl(text)).toBe('string');
  });

  it.each([
    ['nope', 'must be an absolute http(s) URL'],
    ['ftp://vault.example.com', 'must be an absolute http(s) URL'],
    ['https://vault.example.com/?x=1', 'must not contain a query string or fragment'],
    ['https://vault.example.com/#top', 'must not contain a query string or fragment'],
    ['http://vault.example.com', 'must use https unless the host is loopback'],
  ])('rejects %s', (text, message) => {
    expect(normalisePublicUrl(text)).toStrictEqual({ message });
    expect(publicUrlSchema.safeParse(text).error?.issues[0]?.message).toBe(message);
  });
});

describe('decodeSecretKey and secretKeySchema', () => {
  const bytes = Buffer.alloc(32, 7);

  it('decodes hex', () => {
    expect(decodeSecretKey(bytes.toString('hex'))).toStrictEqual(bytes);
  });

  it('decodes base64 and base64url', () => {
    expect(decodeSecretKey(bytes.toString('base64'))).toStrictEqual(bytes);
    expect(decodeSecretKey(bytes.toString('base64url'))).toStrictEqual(bytes);
  });

  it('treats odd-length hex-looking text as base64', () => {
    const text = 'abc'.repeat(15); // 45 chars, hex alphabet, odd length
    expect(decodeSecretKey(text)?.length).toBe(Buffer.from(text, 'base64').length);
  });

  it.each(['', ' '.repeat(3), 'not!valid', Buffer.alloc(31, 1).toString('hex')])(
    'rejects %j',
    (text) => {
      expect(decodeSecretKey(text)).toBeUndefined();
    },
  );

  it('reports the requirement through the schema', () => {
    expect(secretKeySchema.safeParse('short').error?.issues[0]?.message).toBe(
      'must be hex or base64 and decode to at least 32 bytes',
    );
    expect(secretKeySchema.parse(bytes.toString('base64'))).toStrictEqual(bytes);
  });
});

describe('preregisteredClientsSchema', () => {
  it('defaults to no clients', () => {
    expect(preregisteredClientsSchema.parse(undefined)).toStrictEqual([]);
  });

  it('maps snake_case metadata to a typed client', () => {
    const json = JSON.stringify([
      { client_id: 'inspector', redirect_uris: ['http://localhost:6274/oauth/callback'] },
      { client_id: 'ide', client_name: 'IDE', redirect_uris: ['https://ide.example/cb'] },
    ]);
    expect(preregisteredClientsSchema.parse(json)).toStrictEqual([
      {
        clientId: 'inspector',
        clientName: undefined,
        redirectUris: ['http://localhost:6274/oauth/callback'],
      },
      { clientId: 'ide', clientName: 'IDE', redirectUris: ['https://ide.example/cb'] },
    ]);
  });

  it('rejects malformed JSON with a clear message', () => {
    expect(preregisteredClientsSchema.safeParse('[oops').error?.issues[0]?.message).toBe(
      'must be valid JSON',
    );
  });

  it('rejects a client without redirect URIs', () => {
    const json = JSON.stringify([{ client_id: 'x', redirect_uris: [] }]);
    expect(preregisteredClientsSchema.safeParse(json).success).toBe(false);
  });
});

describe('bitwardenServerSchema', () => {
  it.each([undefined, 'bitwarden.eu', 'https://vault.example.com'])('accepts %j', (value) => {
    expect(bitwardenServerSchema.parse(value)).toBe(value);
  });

  it.each(['bitwarden.com', 'http://vault.example.com', 'vault'])('rejects %j', (value) => {
    expect(bitwardenServerSchema.safeParse(value).error?.issues[0]?.message).toBe(
      'must be bitwarden.eu or an https:// URL',
    );
  });
});
