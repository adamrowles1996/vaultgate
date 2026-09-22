import { describe, expect, it } from 'vitest';

import { InMemoryVaultClient } from '../../test-support/in-memory-vault-client.ts';
import { failureCode, runFail, runOk } from '../../test-support/run-tool.ts';
import { CANARY } from '../../test-support/vault-fixture.ts';
import { VaultError } from '../../vault/client.ts';

import { parseSecretField, toolGetSecret } from './reveal.ts';

describe('parseSecretField', () => {
  it('§6.2 recognises every fixed field name and the two prefixed forms', () => {
    expect(parseSecretField('password')).toStrictEqual({ kind: 'password' });
    expect(parseSecretField('totp')).toStrictEqual({ kind: 'totp' });
    expect(parseSecretField('notes')).toStrictEqual({ kind: 'notes' });
    expect(parseSecretField('card.number')).toStrictEqual({ kind: 'card', field: 'number' });
    expect(parseSecretField('card.code')).toStrictEqual({ kind: 'card', field: 'code' });
    expect(parseSecretField('sshKey.privateKey')).toStrictEqual({
      kind: 'sshKey',
      field: 'privateKey',
    });
    expect(parseSecretField('identity.ssn')).toStrictEqual({ kind: 'identity', field: 'ssn' });
    expect(parseSecretField('custom.API key')).toStrictEqual({
      kind: 'customField',
      name: 'API key',
    });
  });

  it('§6.2 rejects unknown and empty forms', () => {
    expect(parseSecretField('identity.')).toBeUndefined();
    expect(parseSecretField('custom.')).toBeUndefined();
    expect(parseSecretField('seed')).toBeUndefined();
  });
});

describe('get_secret', () => {
  const cases: readonly [string, string, unknown][] = [
    ['item-login', 'password', { kind: 'text', value: CANARY.password }],
    ['item-login', 'notes', { kind: 'text', value: CANARY.loginNotes }],
    ['item-login', 'custom.API key', { kind: 'text', value: CANARY.hiddenField }],
    ['item-note', 'notes', { kind: 'text', value: CANARY.secureNote }],
    ['item-card', 'card.number', { kind: 'text', value: CANARY.cardNumber }],
    ['item-card', 'card.code', { kind: 'text', value: CANARY.cardCode }],
    ['item-identity', 'identity.ssn', { kind: 'text', value: CANARY.identitySsn }],
    ['item-identity', 'identity.passportNumber', { kind: 'text', value: CANARY.identityPassport }],
    ['item-ssh', 'sshKey.privateKey', { kind: 'text', value: CANARY.sshPrivateKey }],
  ];

  it.each(cases)('§6.2 reveals %s %s', async (itemId, field, expected) => {
    const output = await runOk(toolGetSecret, new InMemoryVaultClient(), {
      item_id: itemId,
      field,
    });
    expect(output).toStrictEqual(expected);
  });

  it('MCP-11 returns a TOTP code and its validity, never the seed', async () => {
    const output = await runOk(toolGetSecret, new InMemoryVaultClient(), {
      item_id: 'item-login',
      field: 'totp',
    });
    expect(output).toStrictEqual({ kind: 'totp', code: '123456', seconds_remaining: 30 });
    expect(JSON.stringify(output)).not.toContain(CANARY.totpSeed);
  });

  it('§6.2 rejects an unknown field name before touching the vault', async () => {
    const vault = new InMemoryVaultClient();
    vault.failWith(new VaultError('vault_unavailable', 'down'));
    const failure = await runFail(toolGetSecret, vault, { item_id: 'item-login', field: 'seed' });
    expect(failure.name).toBe('ToolError');
    expect(failure.code).toBe('invalid_field');
  });

  it('§5.4 maps a missing item and a field the item does not have', async () => {
    const vault = new InMemoryVaultClient();
    expect(await failureCode(toolGetSecret, vault, { item_id: 'nope', field: 'password' })).toBe(
      'not_found',
    );
    expect(
      await failureCode(toolGetSecret, vault, { item_id: 'item-note', field: 'password' }),
    ).toBe('invalid_item');
    expect(
      await failureCode(toolGetSecret, vault, { item_id: 'item-card', field: 'identity.ssn' }),
    ).toBe('invalid_item');
    expect(
      await failureCode(toolGetSecret, vault, {
        item_id: 'item-login',
        field: 'custom.Environment',
      }),
    ).toBe('invalid_item');
  });
});
