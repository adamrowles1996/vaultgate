import { describe, expect, it } from 'vitest';

import { actionsEnabled } from '../test-support/actions-config.ts';
import {
  type ActionsHarness,
  createActionsHarness,
  createHttpTarget,
  OPERATOR_ID,
  PUBLIC_ADDRESS,
  targetInput,
} from '../test-support/actions-fixtures.ts';
import { problemPaths } from '../test-support/actions-store-fixtures.ts';
import { unwrapFail, unwrapOk } from '../test-support/result.ts';
import { VaultError } from '../vault/client.ts';

import type { TargetResult } from './targets.ts';

type Overrides = Parameters<typeof targetInput>[0];

function creator(harness: ActionsHarness): (overrides?: Overrides) => Promise<TargetResult> {
  return (overrides) => harness.engine.targets.create(targetInput(overrides), OPERATOR_ID);
}

async function problemsOf(
  create: (overrides?: Overrides) => Promise<TargetResult>,
  overrides: Overrides,
): Promise<readonly string[]> {
  const result = await create(overrides);
  return unwrapFail(result).problems;
}

/**
A client-credentials `oauth2` mapping on the fixture item, its token endpoint at `tokenUrl`.
*/
function oauth2(tokenUrl: string): Record<string, unknown> {
  return {
    mode: 'oauth2',
    token_url: tokenUrl,
    grant: 'client_credentials',
    client_id: '1000.EXAMPLE-CLIENT',
    secret_field: 'password',
  };
}

describe('save-time checks', () => {
  it('ACT-1 ACT-6 refuses a malformed input with every problem listed, a duplicate name and documents the connector schemas refuse', async () => {
    const harness = createActionsHarness();
    const malformed = await harness.engine.targets.create(
      {
        name: 'Bad Name',
        connector: 'ftp',
        description: 'x'.repeat(201),
        destination: {},
        credential: { item_id: '' },
        policy: {},
      },
      OPERATOR_ID,
    );
    expect(problemPaths(unwrapFail(malformed).problems)).toStrictEqual([
      'name',
      'description',
      'connector',
      'credential.item_id',
      'credential.mapping',
    ]);
    await createHttpTarget(harness);
    const create = creator(harness);
    expect(await problemsOf(create, {})).toStrictEqual([
      'name: a target of that name already exists',
    ]);
    const documents = await create({
      name: 'two',
      base_url: 'ftp://x.example.com',
      mapping: { mode: 'nope' },
      policy: { allowed_paths: [], timeout_ms: 1 },
    });
    const refused = unwrapFail(documents);
    expect(problemPaths(refused.problems)).toStrictEqual([
      'destination.base_url',
      'credential.mapping.mode',
      'policy.timeout_ms',
      'policy.allowed_paths',
    ]);
    expect(refused.message).toBe(refused.problems.join('; '));
    const noPaths = await problemsOf(create, { name: 'three', policy: { allowed_paths: [] } });
    expect(problemPaths(noPaths)).toStrictEqual(['policy.allowed_paths']);
  });

  it('14.1 refuses a connector whose schemas have not landed in this build', async () => {
    const harness = createActionsHarness();
    const result = await harness.engine.targets.create(
      { ...targetInput(), connector: 'browser' },
      OPERATOR_ID,
    );
    expect(unwrapFail(result).problems).toStrictEqual([
      'connector: browser is not available in this build',
    ]);
  });

  it('ACT-3 rejects a destination that resolves to a refused address, with the reason, and never connects', async () => {
    const harness = createActionsHarness({
      addresses: {
        'internal.example.com': ['10.0.0.5'],
        'meta.example.com': ['169.254.169.254'],
        'gone.example.com': [],
      },
    });
    const create = creator(harness);
    expect(await problemsOf(create, { base_url: 'https://internal.example.com' })).toStrictEqual([
      'destination: host "internal.example.com" is a private-range address; set internal: true to allow it',
    ]);
    const internal = await create({ base_url: 'https://internal.example.com', internal: true });
    expect(unwrapOk(internal).internal).toBe(true);
    expect(
      await problemsOf(create, {
        name: 'meta',
        base_url: 'https://meta.example.com',
        internal: true,
      }),
    ).toStrictEqual([
      'destination: host "meta.example.com" is a loopback, link-local, multicast or unspecified address, which is refused always',
    ]);
    expect(
      await problemsOf(create, { name: 'gone', base_url: 'https://gone.example.com' }),
    ).toStrictEqual(['destination: host "gone.example.com" does not resolve to any address']);
    expect(harness.lookups).toStrictEqual([
      'internal.example.com',
      'internal.example.com',
      'meta.example.com',
      'gone.example.com',
    ]);
    expect(harness.connector.contexts).toStrictEqual([]);
  });

  it('ACT-3 ACT-124 checks an oauth2 token endpoint at save like a destination host, filed under the credential mapping', async () => {
    const harness = createActionsHarness({
      addresses: { 'sso.example.internal': ['10.0.0.7'], 'gone.example.com': [] },
    });
    const create = creator(harness);
    expect(
      await problemsOf(create, { mapping: oauth2('https://sso.example.internal/token') }),
    ).toStrictEqual([
      'credential.mapping: host "sso.example.internal" is a private-range address; set internal: true to allow it',
    ]);
    expect(
      await problemsOf(create, { mapping: oauth2('https://gone.example.com/token') }),
    ).toStrictEqual([
      'credential.mapping: host "gone.example.com" does not resolve to any address',
    ]);
    const internal = await create({
      mapping: oauth2('https://sso.example.internal/token'),
      internal: true,
    });
    expect(unwrapOk(internal).state).toBe('valid');
    expect(harness.lookups).toStrictEqual([
      'api.example.com',
      'sso.example.internal',
      'api.example.com',
      'gone.example.com',
      'api.example.com',
      'sso.example.internal',
    ]);
    expect(harness.connector.contexts).toStrictEqual([]);
  });

  it('ACT-118 ACT-124 a check lists the oauth2 token endpoint after the destination, with the address a save would find', async () => {
    const harness = createActionsHarness();
    const input = targetInput({ mapping: oauth2('https://auth.example.com/token') });
    const report = await harness.engine.targets.checkChanges('http', {
      destination: input['destination'],
      credential: input['credential'],
      policy: input['policy'],
    });
    expect(report.endpoints).toStrictEqual([
      { host: 'api.example.com', tls: true, address: PUBLIC_ADDRESS, problems: [] },
      { host: 'auth.example.com', tls: true, address: PUBLIC_ADDRESS, problems: [] },
    ]);
    expect(report.problems).toStrictEqual([]);
  });

  it('ACT-4 ACT-124 an oauth2 mapping needs the client secret and the refresh token on the item, and an https token URL', async () => {
    const harness = createActionsHarness();
    const create = creator(harness);
    const mapping = {
      mode: 'oauth2',
      token_url: 'https://auth.example.com/token',
      grant: 'refresh_token',
      client_id: '1000.EXAMPLE-CLIENT',
      secret_field: 'custom.client secret',
      refresh_token_field: 'custom.refresh token',
    };
    expect(await problemsOf(create, { mapping })).toStrictEqual([
      'credential.mapping: the item has no "custom.client secret" field',
      'credential.mapping: the item has no "custom.refresh token" field',
    ]);
    expect(
      await problemsOf(create, {
        mapping: { ...mapping, token_url: 'http://auth.example.com/token' },
        internal: true,
      }),
    ).toStrictEqual([
      'credential.mapping.token_url: must be an https:// URL, even on an internal target: the client secret is sent to it',
    ]);
    const saved = await create({
      mapping: { ...mapping, secret_field: 'password', refresh_token_field: 'custom.API key' },
    });
    expect(unwrapOk(saved).state).toBe('valid');
  });

  it('ACT-57 refuses plain http unless the target is internal', async () => {
    const harness = createActionsHarness({ addresses: { 'intranet.local': ['10.0.0.9'] } });
    const create = creator(harness);
    expect(await problemsOf(create, { base_url: 'http://intranet.local' })).toStrictEqual([
      'destination: plain transport to "intranet.local" needs internal: true',
      'destination: host "intranet.local" is a private-range address; set internal: true to allow it',
    ]);
    const internal = await create({ base_url: 'http://intranet.local', internal: true });
    expect(unwrapOk(internal).destinationSummary).toBe('intranet.local');
  });

  it('ACT-4 checks that the vault item exists and reports every mapped field, without reading a secret', async () => {
    const harness = createActionsHarness();
    const create = creator(harness);
    expect(await problemsOf(create, { item_id: 'item-missing' })).toStrictEqual([
      'credential.item_id: no such item in the vault',
    ]);
    expect(
      await problemsOf(create, {
        item_id: 'item-note',
        mapping: { mode: 'basic', field: 'password' },
      }),
    ).toStrictEqual([
      'credential.mapping: the item has no "login.username" field',
      'credential.mapping: the item has no "password" field',
    ]);
    expect(
      await problemsOf(create, { mapping: { mode: 'bearer', field: 'custom.nope' } }),
    ).toStrictEqual(['credential.mapping: the item has no "custom.nope" field']);
    expect(
      await problemsOf(create, { mapping: { mode: 'bearer', field: 'login.password' } }),
    ).toStrictEqual(['credential.mapping: "login.password" is not a field selector']);
    const totp = await create({ mapping: { mode: 'header', field: 'totp', name: 'X-Code' } });
    expect(unwrapOk(totp).state).toBe('valid');
    const keyed = await create({
      name: 'keyed',
      mapping: { mode: 'basic', field: 'custom.API key', username_from: 'login.username' },
    });
    expect(unwrapOk(keyed).state).toBe('valid');
    harness.vault.failWith(new VaultError('vault_unavailable', 'locked'));
    expect(await problemsOf(create, { name: 'locked' })).toStrictEqual([
      'credential.item_id: the item could not be checked (vault_unavailable)',
    ]);
  });

  it('ACT-35 ACT-88 refuses an open command pattern and any_command without the deployment switch, on any policy that carries them', async () => {
    const harness = createActionsHarness();
    const create = creator(harness);
    expect(
      await problemsOf(create, { policy: { allowed_commands: ['uptime', '*'] } }),
    ).toStrictEqual([
      'policy.allowed_commands: the command pattern "*" would allow every command; set any_command instead',
    ]);
    expect(await problemsOf(create, { policy: { any_command: true } })).toStrictEqual([
      'policy.any_command: VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND is off on this deployment',
    ]);
    expect(await problemsOf(create, { policy: { allowed_commands: 'uptime' } })).toStrictEqual([
      'policy.allowed_commands: must be a list of patterns',
    ]);
    const listed = await create({ policy: { allowed_commands: ['uptime *'] } });
    expect(unwrapOk(listed).state).toBe('valid');
    const allowed = createActionsHarness({
      config: actionsEnabled(['http'], { allowAnyCommand: true }),
    });
    const unrestricted = await creator(allowed)({
      policy: { any_command: true, allowed_commands: ['*'] },
    });
    expect(unwrapOk(unrestricted).state).toBe('valid');
  });
});
