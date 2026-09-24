import { describe, expect, it } from 'vitest';

import {
  winrmCredentialSchema,
  winrmDestinationSchema,
  winrmPolicySchema,
  winrmSchemas,
} from './schemas.ts';

import type { z } from 'zod';

const DIGEST = 'aa11bb22cc33dd44ee55ff6677889900aa11bb22cc33dd44ee55ff6677889900';
const URL = 'https://win.example.com:5986/wsman';

function destination(overrides: Readonly<Record<string, unknown>> = {}): unknown {
  return { url: URL, username: 'vaultgate', ...overrides };
}

function problemsOf(parsed: z.ZodSafeParseResult<unknown>): readonly string[] {
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

function destinationProblems(overrides: Readonly<Record<string, unknown>> = {}): readonly string[] {
  const parsed = winrmDestinationSchema.safeParse(destination(overrides));
  return problemsOf(parsed);
}

function documents(
  destinationInput: unknown,
  policyInput: Readonly<Record<string, unknown>> = {},
): readonly string[] {
  return winrmSchemas.saveProblems({
    destination: winrmDestinationSchema.parse(destinationInput),
    credential: winrmCredentialSchema.parse({}),
    policy: winrmPolicySchema.parse({ allowed_commands: ['Get-ComputerInfo'], ...policyInput }),
  });
}

describe('the winrm destination schema', () => {
  it('§14.6 defaults the shell to powershell and leaves the certificate unpinned', () => {
    const parsed = winrmDestinationSchema.parse(destination());
    expect(parsed).toStrictEqual({ url: URL, username: 'vaultgate', shell: 'powershell' });
    expect(parsed.certificate_sha256).toBeUndefined();
  });

  it('ACT-57 accepts a fingerprint with or without colons, in either case, and stores one form', () => {
    const colons = DIGEST.toUpperCase().replaceAll(/(.{2})(?=.)/gu, '$1:');
    expect(winrmDestinationSchema.parse(destination({ certificate_sha256: colons }))).toMatchObject(
      {
        certificate_sha256: DIGEST,
      },
    );
    expect(winrmDestinationSchema.parse(destination({ certificate_sha256: DIGEST }))).toMatchObject(
      { certificate_sha256: DIGEST },
    );
  });

  it('ACT-57 refuses anything that is not a SHA-256 fingerprint', () => {
    expect(destinationProblems({ certificate_sha256: 'abc' })).toStrictEqual([
      'must be a SHA-256 fingerprint: 64 hexadecimal digits, colons optional',
    ]);
  });

  it('ACT-57 refuses an endpoint that is not an absolute http or https URL without credentials', () => {
    expect(destinationProblems({ url: '/wsman' })).toStrictEqual([
      'must be an absolute URL, such as https://host:5986/wsman',
    ]);
    expect(destinationProblems({ url: 'ftp://win.example.com/' })).toStrictEqual([
      'must be an https:// (or, on an internal target, http://) URL',
    ]);
    expect(destinationProblems({ url: `${URL}?a=1` })).toStrictEqual([
      'must not carry a query string or fragment',
    ]);
    expect(destinationProblems({ url: `${URL}#top` })).toStrictEqual([
      'must not carry a query string or fragment',
    ]);
    expect(destinationProblems({ url: 'https://a:b@win.example.com/wsman' })).toStrictEqual([
      'must not carry credentials',
    ]);
  });

  it('§14.6 refuses a shell it does not serve and an empty login name', () => {
    expect(winrmDestinationSchema.safeParse(destination({ shell: 'bash' })).success).toBe(false);
    expect(winrmDestinationSchema.safeParse(destination({ username: '' })).success).toBe(false);
  });
});

describe('the winrm credential schema', () => {
  it('§14.6 defaults the password field and refuses an empty one', () => {
    expect(winrmCredentialSchema.parse({})).toStrictEqual({ password_field: 'password' });
    expect(winrmCredentialSchema.parse({ password_field: 'custom.host-password' })).toStrictEqual({
      password_field: 'custom.host-password',
    });
    expect(winrmCredentialSchema.safeParse({ password_field: '' }).success).toBe(false);
    expect(winrmCredentialSchema.safeParse({ username_from: 'login.username' }).success).toBe(
      false,
    );
  });
});

describe('the winrm connector schemas', () => {
  it('ACT-57 reports the endpoint as encrypted only when it is https', () => {
    const secure = winrmDestinationSchema.parse(destination());
    expect(winrmSchemas.endpoints(secure)).toStrictEqual([{ host: 'win.example.com', tls: true }]);
    const plain = winrmDestinationSchema.parse(
      destination({ url: 'http://win.example.com:5985/wsman' }),
    );
    expect(winrmSchemas.endpoints(plain)).toStrictEqual([{ host: 'win.example.com', tls: false }]);
  });

  it('ACT-50 names the one vault field the mapping needs', () => {
    expect(winrmSchemas.credentialFields(winrmCredentialSchema.parse({}))).toStrictEqual([
      { name: 'password', selector: 'password', role: 'secret' },
    ]);
  });

  it('ACT-57 refuses a certificate pin on a plain endpoint, where it would do nothing', () => {
    const pinnedPlain = destination({
      url: 'http://win.example.com:5985/wsman',
      certificate_sha256: DIGEST,
    });
    expect(documents(pinnedPlain)).toStrictEqual([
      'destination.certificate_sha256: a certificate pin needs an https:// url',
    ]);
    expect(documents(destination({ url: 'http://win.example.com:5985/wsman' }))).toStrictEqual([]);
    expect(documents(destination({ certificate_sha256: DIGEST }))).toStrictEqual([]);
  });

  it('ACT-88 insists on either command patterns or any_command, never both and never neither', () => {
    expect(documents(destination(), { allowed_commands: [], any_command: true })).toStrictEqual([]);
    expect(documents(destination(), { allowed_commands: [] })).toStrictEqual([
      'policy.allowed_commands: give at least one command pattern, or set any_command',
    ]);
    expect(documents(destination(), { any_command: true })).toStrictEqual([
      'policy: set either allowed_commands or any_command, not both',
    ]);
  });

  it('ACT-43 summarises the destination as the login, the host and the shell, never a credential', () => {
    const parsed = winrmDestinationSchema.parse(destination());
    expect(winrmSchemas.summariseDestination(parsed)).toBe(
      'vaultgate@win.example.com:5986 (powershell)',
    );
  });
});
