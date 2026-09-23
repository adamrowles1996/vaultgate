import { describe, expect, it } from 'vitest';

import { captureLogger } from '../test-support/logging.ts';
import { CLIENT_ID, CLIENT_SECRET, harnessConfig } from '../test-support/supervisor-harness.ts';

import { environmentCredentials, resolveCredentials } from './credential-source.ts';

import type { StoredVaultSettings } from './settings.ts';

const STORED: StoredVaultSettings = {
  kind: 'ok',
  updatedAt: 0,
  values: {
    clientId: 'user.stored',
    clientSecret: 'stored-secret',
    masterPassword: 'stored-master',
    server: 'bitwarden.eu',
  },
};
const NO_SEED = {
  VAULTGATE_BW_CLIENT_ID: undefined,
  VAULTGATE_BW_CLIENT_SECRET: undefined,
  VAULTGATE_BW_PASSWORD: undefined,
};

function warnings(logs: ReturnType<typeof captureLogger>): string[] {
  return logs
    .lines()
    .filter((line) => line['level'] === 40)
    .map((line) => String(line['msg']));
}

describe('resolveCredentials', () => {
  it('VAULT-18 prefers the stored connection over the environment seed', () => {
    const logs = captureLogger();
    const resolved = resolveCredentials(harnessConfig(), STORED, logs.logger);
    expect(resolved?.origin).toBe('settings');
    expect(resolved?.credentials.clientId).toBe('user.stored');
    expect(resolved?.credentials.server).toBe('bitwarden.eu');
    expect(resolved?.credentials.masterPassword()).toBe('stored-master');
    expect(warnings(logs)).toStrictEqual([]);
  });

  it('VAULT-18 falls back to a complete environment seed', () => {
    const logs = captureLogger();
    const config = harnessConfig({ VAULTGATE_BW_SERVER: 'https://self.example' });
    const resolved = resolveCredentials(config, { kind: 'none' }, logs.logger);
    expect(resolved?.origin).toBe('environment');
    expect(resolved?.credentials.clientId).toBe(CLIENT_ID);
    expect(resolved?.credentials.clientSecret()).toBe(CLIENT_SECRET);
    expect(resolved?.credentials.server).toBe('https://self.example');
    expect(warnings(logs)).toStrictEqual([]);
  });

  it('VAULT-18 is unconfigured with neither a stored row nor a seed, silently', () => {
    const logs = captureLogger();
    expect(
      resolveCredentials(harnessConfig(NO_SEED), { kind: 'none' }, logs.logger),
    ).toBeUndefined();
    expect(logs.lines()).toStrictEqual([]);
  });

  it('VAULT-18 warns about and ignores a partial environment seed', () => {
    const logs = captureLogger();
    const config = harnessConfig({ ...NO_SEED, VAULTGATE_BW_CLIENT_ID: 'user.alone' });
    expect(environmentCredentials(config, logs.logger)).toBeUndefined();
    expect(warnings(logs)).toStrictEqual([
      'VAULTGATE_BW_CLIENT_ID, VAULTGATE_BW_CLIENT_SECRET and VAULTGATE_BW_PASSWORD must all be set to seed the vault connection; ignoring the partial set',
    ]);
  });

  it('STORE-8 warns when the stored row cannot be decrypted and uses the seed instead', () => {
    const logs = captureLogger();
    const resolved = resolveCredentials(harnessConfig(), { kind: 'undecryptable' }, logs.logger);
    expect(resolved?.origin).toBe('environment');
    expect(warnings(logs)).toStrictEqual([
      'the stored vault connection cannot be decrypted under VAULTGATE_SECRET_KEY; save it again on the account page',
    ]);
  });
});
