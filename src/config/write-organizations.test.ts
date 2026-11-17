import { describe, expect, it } from 'vitest';

import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { loadConfig } from './index.ts';

const REQUIRED = {
  VAULTGATE_PUBLIC_URL: 'https://vault.example.com',
  VAULTGATE_SECRET_KEY: Buffer.alloc(32, 1).toString('base64'),
};

describe('VAULTGATE_WRITE_ORGANIZATIONS', () => {
  it('MCP-19 lets no organisation be written into by default', () => {
    expect(unwrapOk(loadConfig(REQUIRED)).config.writeOrganizations).toStrictEqual([]);
  });

  it('MCP-19 reads a comma-separated list of organisation ids, lower-cased', () => {
    const loaded = loadConfig({
      ...REQUIRED,
      VAULTGATE_WRITE_ORGANIZATIONS: '630C2282-70AF-436E-8888-0219F68C01EE, ',
    });
    expect(unwrapOk(loaded).config.writeOrganizations).toStrictEqual([
      '630c2282-70af-436e-8888-0219f68c01ee',
    ]);
  });

  it('MCP-19 refuses anything but an organisation id, stopping start-up', () => {
    const loaded = loadConfig({ ...REQUIRED, VAULTGATE_WRITE_ORGANIZATIONS: 'Example' });
    expect(unwrapFail(loaded).message).toContain('VAULTGATE_WRITE_ORGANIZATIONS');
  });
});
