import { describe, expect, it } from 'vitest';

import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { ConfigError, describeConfig, loadConfig } from './index.ts';

import type { SecretFile } from './secret-files.ts';

const KEY_BYTES = Buffer.alloc(32, 1);
const REQUIRED = {
  VAULTGATE_PUBLIC_URL: 'https://vault.example.com',
  VAULTGATE_SECRET_KEY: KEY_BYTES.toString('base64'),
  VAULTGATE_BW_PASSWORD: 'master-password',
  VAULTGATE_BW_CLIENT_ID: 'user.abc',
  VAULTGATE_BW_CLIENT_SECRET: 'client-secret',
};

const files: Record<string, SecretFile> = {
  '/run/secrets/master': { value: 'master-from-file', worldReadable: false },
  '/run/secrets/key': { value: KEY_BYTES.toString('hex'), worldReadable: true },
  '/run/secrets/blank': { value: '', worldReadable: false },
};

function readSecretFile(path: string): SecretFile {
  const file = files[path];
  if (file === undefined) {
    throw new Error(`ENOENT: ${path}`);
  }
  return file;
}

function load(environment: Record<string, string | undefined>): ReturnType<typeof loadConfig> {
  return loadConfig(environment, { readSecretFile });
}

describe('loadConfig', () => {
  it('OPS-6 reads VAULTGATE_TRUSTED_PROXY_HOPS as an integer between 1 and 10', () => {
    const { config } = unwrapOk(load({ ...REQUIRED, VAULTGATE_TRUSTED_PROXY_HOPS: '3' }));
    expect(config.trustedProxyHops).toBe(3);
    for (const value of ['0', '11', '1.5', 'two']) {
      const error = unwrapFail(load({ ...REQUIRED, VAULTGATE_TRUSTED_PROXY_HOPS: value }));
      expect(error.issues.map((issue) => issue.split(':', 1)[0])).toStrictEqual([
        'VAULTGATE_TRUSTED_PROXY_HOPS',
      ]);
    }
  });

  it('produces loopback-safe defaults from the required variables alone', () => {
    const { config, warnings } = unwrapOk(load(REQUIRED));
    expect(warnings).toStrictEqual([]);
    expect(config).toStrictEqual({
      publicUrl: 'https://vault.example.com',
      host: '127.0.0.1',
      port: 8080,
      trustProxy: false,
      trustedProxyHops: 1,
      allowedOrigins: [],
      dataDir: './data',
      enableWriteScope: false,
      oauthClients: [],
      accessTokenTtlMs: 3_600_000,
      refreshTokenTtlMs: 2_592_000_000,
      sessionTtlMs: 43_200_000,
      auditRetentionDays: 365,
      sqliteNetworkFs: false,
      logLevel: 'info',
      bitwarden: { server: undefined, bin: 'bw', clientId: 'user.abc', syncIntervalMs: 900_000 },
      actions: {
        enabled: false,
        connectors: {
          http: false,
          sql: false,
          ssh: false,
          winrm: false,
          browser: false,
          code: false,
        },
        browserCdpUrl: undefined,
        codeUrl: undefined,
        allowAnyCommand: false,
      },
      secrets: {
        secretKey: KEY_BYTES,
        masterPassword: 'master-password',
        clientSecret: 'client-secret',
        bootstrapToken: undefined,
      },
    });
  });

  it('honours every override, including values supplied through _FILE variables', () => {
    const { config, warnings } = unwrapOk(
      load({
        VAULTGATE_PUBLIC_URL: 'https://vault.example.com/base/',
        VAULTGATE_HOST: '0.0.0.0',
        VAULTGATE_PORT: '9443',
        VAULTGATE_TRUST_PROXY: 'true',
        VAULTGATE_TRUSTED_PROXY_HOPS: '2',
        VAULTGATE_ALLOWED_ORIGINS: 'https://claude.ai, https://ide.example',
        VAULTGATE_DATA_DIR: '/var/lib/vaultgate',
        VAULTGATE_SECRET_KEY_FILE: '/run/secrets/key',
        VAULTGATE_BW_PASSWORD: 'ignored-when-file-is-set',
        VAULTGATE_BW_PASSWORD_FILE: '/run/secrets/master',
        VAULTGATE_BW_CLIENT_ID: 'user.abc',
        VAULTGATE_BW_CLIENT_SECRET: 'client-secret',
        VAULTGATE_BW_SERVER: 'https://vaultwarden.example',
        VAULTGATE_BW_BIN: '/usr/local/bin/bw',
        VAULTGATE_BW_SYNC_INTERVAL: '5m',
        VAULTGATE_ENABLE_WRITE_SCOPE: '1',
        VAULTGATE_OAUTH_CLIENTS: JSON.stringify([
          { client_id: 'inspector', redirect_uris: ['http://localhost:6274/oauth/callback'] },
        ]),
        VAULTGATE_BOOTSTRAP_TOKEN: 'bootstrap-token-of-sixteen',
        VAULTGATE_ACCESS_TOKEN_TTL: '30m',
        VAULTGATE_REFRESH_TOKEN_TTL: '7d',
        VAULTGATE_SESSION_TTL: '1h',
        VAULTGATE_AUDIT_RETENTION_DAYS: '90',
        VAULTGATE_SQLITE_NETWORK_FS: 'true',
        VAULTGATE_LOG_LEVEL: 'debug',
      }),
    );
    expect(warnings).toStrictEqual([
      'VAULTGATE_SECRET_KEY_FILE: /run/secrets/key is world-readable; restrict it to the service user',
    ]);
    expect(config).toStrictEqual({
      publicUrl: 'https://vault.example.com/base',
      host: '0.0.0.0',
      port: 9443,
      trustProxy: true,
      trustedProxyHops: 2,
      allowedOrigins: ['https://claude.ai', 'https://ide.example'],
      dataDir: '/var/lib/vaultgate',
      enableWriteScope: true,
      oauthClients: [
        {
          clientId: 'inspector',
          clientName: undefined,
          redirectUris: ['http://localhost:6274/oauth/callback'],
        },
      ],
      accessTokenTtlMs: 1_800_000,
      refreshTokenTtlMs: 604_800_000,
      sessionTtlMs: 3_600_000,
      auditRetentionDays: 90,
      sqliteNetworkFs: true,
      logLevel: 'debug',
      bitwarden: {
        server: 'https://vaultwarden.example',
        bin: '/usr/local/bin/bw',
        clientId: 'user.abc',
        syncIntervalMs: 300_000,
      },
      actions: {
        enabled: false,
        connectors: {
          http: false,
          sql: false,
          ssh: false,
          winrm: false,
          browser: false,
          code: false,
        },
        browserCdpUrl: undefined,
        codeUrl: undefined,
        allowAnyCommand: false,
      },
      secrets: {
        secretKey: KEY_BYTES,
        masterPassword: 'master-from-file',
        clientSecret: 'client-secret',
        bootstrapToken: 'bootstrap-token-of-sixteen',
      },
    });
  });

  it('CFG-5 needs no Bitwarden credentials: the account page can supply them later', () => {
    const { config } = unwrapOk(
      load({
        VAULTGATE_PUBLIC_URL: REQUIRED.VAULTGATE_PUBLIC_URL,
        VAULTGATE_SECRET_KEY: REQUIRED.VAULTGATE_SECRET_KEY,
      }),
    );
    expect(config.bitwarden.clientId).toBeUndefined();
    expect(config.secrets.masterPassword).toBeUndefined();
    expect(config.secrets.clientSecret).toBeUndefined();
    expect(describeConfig(config)['secrets']).toStrictEqual({
      secretKey: '[set]',
      masterPassword: '[unset]',
      clientSecret: '[unset]',
      bootstrapToken: '[unset]',
    });
  });

  it('CFG-1 treats an empty secret file as unset, like an empty variable', () => {
    const { config } = unwrapOk(
      load({ ...REQUIRED, VAULTGATE_BW_PASSWORD_FILE: '/run/secrets/blank' }),
    );
    expect(config.secrets.masterPassword).toBeUndefined();
  });

  it('treats empty values as unset', () => {
    const { config } = unwrapOk(load({ ...REQUIRED, VAULTGATE_BW_SERVER: '', VAULTGATE_PORT: '' }));
    expect(config.bitwarden.server).toBeUndefined();
    expect(config.port).toBe(8080);
  });

  it('reports every problem at once, each prefixed with its variable', () => {
    const error = unwrapFail(
      load({
        VAULTGATE_PUBLIC_URL: 'http://vault.example.com',
        VAULTGATE_PORT: '0',
        VAULTGATE_SECRET_KEY: 'too-short',
        VAULTGATE_BW_CLIENT_ID: 'user.abc',
        VAULTGATE_BW_CLIENT_SECRET: 'client-secret',
        VAULTGATE_BW_SYNC_INTERVAL: '10s',
        VAULTGATE_BOOTSTRAP_TOKEN: 'short',
        VAULTGATE_LOG_LEVEL: 'loud',
      }),
    );
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.name).toBe('ConfigError');
    expect(error.message).toContain('Invalid configuration:\n  - VAULTGATE_PUBLIC_URL: ');
    expect(error.issues.map((issue) => issue.split(':', 1)[0])).toStrictEqual([
      'VAULTGATE_PUBLIC_URL',
      'VAULTGATE_PORT',
      'VAULTGATE_SECRET_KEY',
      'VAULTGATE_BW_SYNC_INTERVAL',
      'VAULTGATE_BOOTSTRAP_TOKEN',
      'VAULTGATE_LOG_LEVEL',
    ]);
  });

  it('lists unreadable secret files before schema problems', () => {
    const error = unwrapFail(load({ ...REQUIRED, VAULTGATE_BW_CLIENT_SECRET_FILE: '/nowhere' }));
    expect(error.issues).toStrictEqual([
      'VAULTGATE_BW_CLIENT_SECRET_FILE: cannot read /nowhere (ENOENT: /nowhere)',
    ]);
  });

  it('reports an unreadable secret file together with other problems', () => {
    const error = unwrapFail(
      load({ ...REQUIRED, VAULTGATE_PORT: 'many', VAULTGATE_BW_PASSWORD_FILE: '/nowhere' }),
    );
    expect(error.issues).toHaveLength(2);
    expect(error.issues[0]).toMatch(/^VAULTGATE_BW_PASSWORD_FILE: cannot read/);
    expect(error.issues[1]).toMatch(/^VAULTGATE_PORT: /);
  });

  it('reads secret files from disk when no reader is injected', () => {
    const error = unwrapFail(loadConfig({ VAULTGATE_SECRET_KEY_FILE: '/definitely/not/here' }));
    expect(error.issues[0]).toMatch(
      /^VAULTGATE_SECRET_KEY_FILE: cannot read \/definitely\/not\/here/,
    );
  });
});

describe('describeConfig', () => {
  it('replaces every secret with a set/unset marker and keeps everything else', () => {
    const { config } = unwrapOk(load(REQUIRED));
    const description = describeConfig(config);
    expect(description['secrets']).toStrictEqual({
      secretKey: '[set]',
      masterPassword: '[set]',
      clientSecret: '[set]',
      bootstrapToken: '[unset]',
    });
    expect(description['publicUrl']).toBe('https://vault.example.com');
    const serialised = JSON.stringify(description);
    for (const secret of ['master-password', 'client-secret', KEY_BYTES.toString('base64')]) {
      expect(serialised).not.toContain(secret);
    }
  });

  it('marks a present bootstrap token as set', () => {
    const { config } = unwrapOk(
      load({ ...REQUIRED, VAULTGATE_BOOTSTRAP_TOKEN: 'bootstrap-token-of-sixteen' }),
    );
    expect(describeConfig(config)['secrets']).toMatchObject({ bootstrapToken: '[set]' });
  });
});
