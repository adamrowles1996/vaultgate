import { describe, expect, it } from 'vitest';

import { PUBLIC_ADDRESS } from '../test-support/actions-fixtures.ts';
import { fixtureTargetRow } from '../test-support/actions-store-fixtures.ts';
import { InMemoryVaultClient } from '../test-support/in-memory-vault-client.ts';
import { captureLogger } from '../test-support/logging.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';
import { CANARY } from '../test-support/vault-fixture.ts';
import { VaultError } from '../vault/client.ts';

import { createRunSupport } from './run-support.ts';
import { createSecretHolder } from './secrets.ts';

import type { TargetRow } from './targets-schemas.ts';
import type { AuditEvent } from '../audit/event.ts';
import type { Lookup } from '../net/ip-ranges.ts';
import type { RunSupport } from './connectors/connector.ts';

const TOKEN_HOST = { host: 'login.microsoftonline.com', tls: true };

interface Built {
  readonly support: RunSupport;
  readonly vault: InMemoryVaultClient;
  readonly audit: AuditEvent[];
  readonly logged: () => readonly Record<string, unknown>[];
  readonly holder: ReturnType<typeof createSecretHolder>;
}

function build(
  row: TargetRow = fixtureTargetRow(),
  addresses: readonly string[] = [PUBLIC_ADDRESS],
): Built {
  const vault = new InMemoryVaultClient();
  const audit: AuditEvent[] = [];
  const { logger, lines } = captureLogger();
  const lookup: Lookup = () => Promise.resolve(addresses);
  const holder = createSecretHolder([], undefined);
  const support = createRunSupport(
    {
      vault,
      lookup,
      audit: {
        record: (event) => {
          audit.push(event);
        },
      },
      logger,
    },
    row,
    holder,
  );
  return { support, vault, audit, logged: lines, holder };
}

describe('the run support the engine lends a connector', () => {
  it('ACT-82 names the target by id, name and revision, and never the vault item', () => {
    const { support } = build(fixtureTargetRow({ id: 'row-9', name: 'graph', revision: 4 }));
    expect(support.target).toStrictEqual({ id: 'row-9', name: 'graph', revision: 4 });
  });

  it('ACT-55 ACT-56 resolves a second host under the target rules and maps a refusal to its code', async () => {
    const public_ = await build().support.resolve(TOKEN_HOST);
    expect(unwrapOk(public_)).toStrictEqual({ ...TOKEN_HOST, address: PUBLIC_ADDRESS });
    const unresolved = await build(fixtureTargetRow(), []).support.resolve(TOKEN_HOST);
    expect(unwrapFail(unresolved)).toMatchObject({
      code: 'connection_failed',
      detail: { reason: 'unresolved' },
    });
    const private_ = await build(fixtureTargetRow(), ['10.0.0.1']).support.resolve(TOKEN_HOST);
    expect(unwrapFail(private_)).toMatchObject({
      code: 'destination_refused',
      detail: { reason: 'private' },
    });
    const internal = await build(fixtureTargetRow({ internal: true }), [
      '10.0.0.1',
    ]).support.resolve(TOKEN_HOST);
    expect(unwrapOk(internal).address).toBe('10.0.0.1');
  });

  it('ACT-51 a captured value joins the call scrub table', () => {
    const { support, holder } = build();
    support.capture('graph.access_token', Buffer.from('a-token', 'utf8'));
    expect(holder.scrub.text('a-token')).toBe('[redacted:graph.access_token]');
  });

  it('ACT-83 writes a rotated custom field to the item and audits the item and field, never the value', async () => {
    const { support, vault, audit } = build();
    const written = await support.rotate('custom.API key', 'rotated-value');
    expect(written).toStrictEqual({ ok: true, value: undefined });
    expect(vault.storedSecrets('item-login')?.hiddenFields).toMatchObject({
      'API key': 'rotated-value',
    });
    expect(audit).toStrictEqual([
      {
        category: 'actions',
        action: 'credential_rotated',
        outcome: 'ok',
        itemId: 'item-login',
        field: 'custom.API key',
        details: { target: 'row', connector: 'http' },
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain('rotated-value');
  });

  it('ACT-83 writes the login password and the notes, the other two fields the vault contract can set', async () => {
    const password = build();
    const written = await password.support.rotate('password', 'new-password');
    expect(written).toStrictEqual({ ok: true, value: undefined });
    expect(password.vault.storedSecrets('item-login')?.password).toBe('new-password');
    const notes = build();
    const noted = await notes.support.rotate('notes', 'new-notes');
    expect(noted).toStrictEqual({ ok: true, value: undefined });
    expect(notes.vault.storedSecrets('item-login')?.notes).toBe('new-notes');
  });

  it('ACT-83 refuses a selector the vault contract cannot write and one that is not a selector at all', async () => {
    const { support, vault, audit, logged } = build();
    for (const selector of ['totp', 'card.number', 'login.username', 'nonsense']) {
      const refused = await support.rotate(selector, 'x');
      expect(unwrapFail(refused)).toMatchObject({
        code: 'credential_rotation_failed',
        detail: { reason: 'unwritable_field' },
      });
    }
    expect(vault.storedSecrets('item-login')?.password).toBe(CANARY.password);
    expect(audit).toStrictEqual([]);
    expect(logged()).toHaveLength(4);
  });

  it('ACT-83 a vault that refuses the write fails the call with the vault code in the detail', async () => {
    const { support, vault, audit } = build();
    vault.failWith(new VaultError('vault_unavailable', 'locked'));
    const refused = await support.rotate('custom.API key', 'x');
    expect(unwrapFail(refused)).toMatchObject({
      code: 'credential_rotation_failed',
      detail: { reason: 'vault_unavailable' },
    });
    expect(audit).toStrictEqual([]);
  });
});
