import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from './config.ts';

describe('loadConfig', () => {
  it('applies loopback-safe defaults when nothing is set', () => {
    const result = loadConfig({});
    expect(result).toEqual({
      ok: true,
      value: { host: '127.0.0.1', port: 8080, logLevel: 'info' },
    });
  });

  it('reads explicit values and coerces the port', () => {
    const result = loadConfig({
      VAULTGATE_HOST: '0.0.0.0',
      VAULTGATE_PORT: '9443',
      VAULTGATE_LOG_LEVEL: 'debug',
    });
    expect(result).toEqual({
      ok: true,
      value: { host: '0.0.0.0', port: 9443, logLevel: 'debug' },
    });
  });

  it('rejects an out-of-range port and an unknown log level with named issues', () => {
    const result = loadConfig({ VAULTGATE_PORT: '70000', VAULTGATE_LOG_LEVEL: 'loud' });
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.error).toBeInstanceOf(ConfigError);
    expect(result.error.name).toBe('ConfigError');
    expect(result.error.issues).toHaveLength(2);
    expect(result.error.issues[0]).toMatch(/^VAULTGATE_PORT: /);
    expect(result.error.issues[1]).toMatch(/^VAULTGATE_LOG_LEVEL: /);
    expect(result.error.message).toContain('Invalid configuration:');
  });

  it('rejects an empty host', () => {
    const result = loadConfig({ VAULTGATE_HOST: '' });
    expect(result.ok).toBe(false);
  });
});
