import { describe, expect, it } from 'vitest';

import { InMemoryVaultClient } from '../../test-support/in-memory-vault-client.ts';
import { failureCode, runOk } from '../../test-support/run-tool.ts';
import { VaultError } from '../../vault/client.ts';

import { toolGeneratePassphrase, toolGeneratePassword } from './generate.ts';

function downVault(): InMemoryVaultClient {
  const vault = new InMemoryVaultClient();
  vault.failWith(new VaultError('vault_unavailable', 'down'));
  return vault;
}

describe('generate_password', () => {
  it('§6.2 applies defaults and passes every option through', async () => {
    const vault = new InMemoryVaultClient();
    expect(await runOk(toolGeneratePassword, vault, {})).toStrictEqual({
      password: 'Aa1!'.repeat(6),
    });
    const custom = await runOk(toolGeneratePassword, vault, {
      length: 10,
      uppercase: false,
      special: false,
    });
    expect(custom).toStrictEqual({ password: 'a1a1a1a1a1' });
    expect(() => toolGeneratePassword.inputSchema.parse({ length: 4 })).toThrow('8');
  });

  it('VAULT-5 maps a vault failure', async () => {
    expect(await failureCode(toolGeneratePassword, downVault(), {})).toBe('vault_unavailable');
  });
});

describe('generate_passphrase', () => {
  it('§6.2 applies defaults and passes every option through', async () => {
    const vault = new InMemoryVaultClient();
    expect(await runOk(toolGeneratePassphrase, vault, {})).toStrictEqual({
      passphrase: 'word1-word2-word3-word4',
    });
    const custom = await runOk(toolGeneratePassphrase, vault, {
      words: 3,
      separator: '.',
      capitalize: true,
      include_number: true,
    });
    expect(custom).toStrictEqual({ passphrase: 'Word1.Word2.Word3.7' });
  });

  it('VAULT-5 maps a vault failure', async () => {
    expect(await failureCode(toolGeneratePassphrase, downVault(), {})).toBe('vault_unavailable');
  });
});
