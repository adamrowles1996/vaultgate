import { describe, expect, it } from 'vitest';

import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { codeUrlProblem, codeUrlSchema } from './actions.ts';
import { loadConfig } from './index.ts';

const REQUIRED = {
  VAULTGATE_PUBLIC_URL: 'https://vault.example.com',
  VAULTGATE_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
};

const NOT_A_SIDECAR_URL = 'must be an http:// URL or unix: and a socket path';

describe('the code sidecar URL (ACT-113, 13.14)', () => {
  it('ACT-113 accepts unix: and an absolute socket path, and http:// on a private address or a named host', () => {
    const accepted = [
      'unix:/run/vaultgate-code/sidecar.sock',
      'http://code:8080',
      'http://10.0.0.5:8080',
      'http://[fd00::7]:8080',
      'http://vaultgate-code.internal.example.net',
      'http://localhost-code:8080',
    ];
    expect(accepted.filter((url) => codeUrlProblem(url) !== undefined)).toStrictEqual([]);
  });

  it('ACT-114 refuses loopback, link-local and every other forbidden address, and localhost, for an http:// sidecar', () => {
    const local = [
      'http://127.0.0.1:8080/',
      'http://127.8.9.1:8080',
      'http://2130706433:8080',
      'http://0x7f.1:8080',
      'http://[::1]:8080',
      'http://[::ffff:127.0.0.1]:8080',
      'http://0.0.0.0:8080',
      'http://169.254.169.254',
      'http://[fe80::1]:8080',
      'http://224.0.0.1:8080',
      'http://localhost:8080',
      'http://LOCALHOST.:8080',
      'http://code.localhost:8080',
    ];
    expect(new Set(local.map((url) => codeUrlProblem(url)))).toStrictEqual(
      new Set([
        'must not be a loopback, link-local or other reserved address, or localhost; a local sidecar is reached on a unix: socket',
      ]),
    );
  });

  it('ACT-113 refuses a public address, another scheme, credentials, a path, a relative or NUL socket path', () => {
    expect(
      [
        'http://93.184.216.34:8080',
        'https://code:8443',
        'ws://code:8080',
        'http://user:pass@code:8080',
        'http://code:8080/v1',
        'http://code:8080/?x=1',
        'http://code:8080/#x',
        'unix:run/sidecar.sock',
        'unix:/run/side\0car.sock',
        'not a url',
      ].map((url) => codeUrlProblem(url)),
    ).toStrictEqual([
      'must not be a public address; the sidecar is reached on an internal network',
      NOT_A_SIDECAR_URL,
      NOT_A_SIDECAR_URL,
      NOT_A_SIDECAR_URL,
      'must name the sidecar itself, with no path, query or fragment',
      'must name the sidecar itself, with no path, query or fragment',
      'must name the sidecar itself, with no path, query or fragment',
      'a unix: URL must name an absolute socket path',
      'a unix: URL must name an absolute socket path',
      NOT_A_SIDECAR_URL,
    ]);
  });

  it('13.14 the schema is optional and carries the problem as its issue', () => {
    expect(codeUrlSchema.parse(undefined)).toBeUndefined();
    expect(codeUrlSchema.parse('http://code:8080')).toBe('http://code:8080');
    expect(
      codeUrlSchema.safeParse('http://8.8.8.8').error?.issues.map((issue) => issue.message),
    ).toStrictEqual([
      'must not be a public address; the sidecar is reached on an internal network',
    ]);
  });

  it('13.14 VAULTGATE_ACTIONS_ENABLE_CODE requires VAULTGATE_ACTIONS_CODE_URL, and a bad URL is refused at start-up', () => {
    const missing = unwrapFail(
      loadConfig({
        ...REQUIRED,
        VAULTGATE_ENABLE_ACTIONS: 'true',
        VAULTGATE_ACTIONS_ENABLE_CODE: 'true',
      }),
    );
    expect(missing.issues).toStrictEqual([
      'VAULTGATE_ACTIONS_CODE_URL: is required when VAULTGATE_ACTIONS_ENABLE_CODE is true',
    ]);
    const publicUrl = unwrapFail(
      loadConfig({ ...REQUIRED, VAULTGATE_ACTIONS_CODE_URL: 'http://93.184.216.34' }),
    );
    expect(publicUrl.issues).toStrictEqual([
      'VAULTGATE_ACTIONS_CODE_URL: must not be a public address; the sidecar is reached on an internal network',
    ]);
    const { config } = unwrapOk(
      loadConfig({
        ...REQUIRED,
        VAULTGATE_ENABLE_ACTIONS: 'true',
        VAULTGATE_ACTIONS_ENABLE_CODE: 'true',
        VAULTGATE_ACTIONS_CODE_URL: 'http://code:8080',
      }),
    );
    expect([config.actions.connectors.code, config.actions.codeUrl]).toStrictEqual([
      true,
      'http://code:8080',
    ]);
  });
});
