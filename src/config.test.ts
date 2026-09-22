import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.ts';
import { unwrapFail, unwrapOk } from './test-support/result.ts';

describe('loadConfig', () => {
  it('applies loopback-safe defaults when nothing is set', () => {
    expect(unwrapOk(loadConfig({}))).toStrictEqual({
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'info',
    });
  });

  it('reads explicit values and coerces the port', () => {
    const config = unwrapOk(
      loadConfig({
        VAULTGATE_HOST: '0.0.0.0',
        VAULTGATE_PORT: '9443',
        VAULTGATE_LOG_LEVEL: 'debug',
      }),
    );
    expect(config).toStrictEqual({ host: '0.0.0.0', port: 9443, logLevel: 'debug' });
  });

  it('rejects an out-of-range port and an unknown log level with named issues', () => {
    const error = unwrapFail(loadConfig({ VAULTGATE_PORT: '70000', VAULTGATE_LOG_LEVEL: 'loud' }));
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.name).toBe('ConfigError');
    expect(error.issues).toHaveLength(2);
    expect(error.issues[0]).toMatch(/^VAULTGATE_PORT: /);
    expect(error.issues[1]).toMatch(/^VAULTGATE_LOG_LEVEL: /);
    expect(error.message).toContain('Invalid configuration:');
  });

  it('rejects an empty host', () => {
    expect(unwrapFail(loadConfig({ VAULTGATE_HOST: '' })).issues[0]).toMatch(/^VAULTGATE_HOST: /);
  });
});
