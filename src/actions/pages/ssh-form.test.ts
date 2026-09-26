import { describe, expect, it } from 'vitest';

import { createPagesHarness, signedInOperator } from '../../test-support/actions-pages.ts';
import { HOST_KEYS } from '../../test-support/fake-ssh-client.ts';
import { createSshTarget, SSH_HOST } from '../../test-support/ssh-connector.ts';

import { formFor } from './forms.ts';

import type { PagesHarness } from '../../test-support/actions-pages.ts';

const ANY_COMMAND_FIELD = 'policy.any_command';

function fieldNames(isAnyCommandAllowed: boolean): readonly string[] {
  const form = formFor('ssh', { allowAnyCommand: isAnyCommandAllowed });
  return (form?.fields ?? []).map((field) => `${field.document}.${field.name}`);
}

async function markup(harness: PagesHarness, path: string): Promise<string> {
  const { browser } = await signedInOperator(harness);
  const page = await browser.get(path);
  return page.text();
}

describe('the ssh form', () => {
  it('ACT-6 offers the destination, credential and policy fields of §14.5', () => {
    expect(fieldNames(true)).toStrictEqual([
      'destination.host',
      'destination.port',
      'destination.username',
      'destination.host_key',
      'credential.auth',
      'credential.key_field',
      'credential.passphrase_field',
      'credential.password_field',
      'policy.allowed_commands',
      'policy.any_command',
      'policy.timeout_ms',
      'policy.max_output_bytes',
      'policy.rate_limit_per_minute',
      'policy.confirm_writes',
    ]);
  });

  it('ACT-88 leaves the any-command box out entirely on a deployment that does not allow one', () => {
    expect(fieldNames(false)).not.toContain(ANY_COMMAND_FIELD);
  });

  it('ACT-88 draws the any-command box only where the deployment allows it', async () => {
    const off = await markup(
      createPagesHarness(),
      '/account/actions/new?connector=ssh&item=item-ssh',
    );
    expect(off).toContain('name="destination.host_key"');
    expect(off).not.toContain(`name="${ANY_COMMAND_FIELD}"`);
    const on = await markup(
      createPagesHarness({ allowAnyCommand: true }),
      '/account/actions/new?connector=ssh&item=item-ssh',
    );
    expect(on).toContain(`name="${ANY_COMMAND_FIELD}"`);
  });

  it('ACT-88 refuses a submission that names the any-command field on a deployment that forbids it, rather than dropping it silently', async () => {
    const harness = createPagesHarness({ addresses: { [SSH_HOST]: ['93.184.216.34'] } });
    const { browser, csrf } = await signedInOperator(harness);
    // The form never draws the field, so only a hand-made request carries it;
    // an operator who sends one must be told why it is refused, and no target
    // may be created as though the field had never been there.
    const response = await browser.submit('/account/actions', {
      csrf,
      connector: 'ssh',
      name: 'build-host',
      description: 'The build server',
      'credential.item_id': 'item-ssh',
      'destination.host': SSH_HOST,
      'destination.port': '22',
      'destination.username': 'vaultgate',
      'destination.host_key': HOST_KEYS.pinned,
      'credential.auth': 'key',
      'credential.key_field': 'sshKey.privateKey',
      'policy.allowed_commands': 'uptime',
      [ANY_COMMAND_FIELD]: 'on',
      'policy.timeout_ms': '30000',
      'policy.max_output_bytes': '262144',
      'policy.rate_limit_per_minute': '60',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      'policy.any_command: VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND is off on this deployment',
    );
    expect(harness.actions.engine.targets.list()).toStrictEqual([]);
  });

  it('ACT-88 refuses the same field on an edit, leaving the stored target untouched', async () => {
    const harness = createPagesHarness({ addresses: { [SSH_HOST]: ['93.184.216.34'] } });
    const target = await createSshTarget(harness.actions);
    const { browser, csrf } = await signedInOperator(harness);
    const response = await browser.submit(`/account/actions/${target.id}`, {
      csrf,
      description: 'The build server',
      'credential.item_id': 'item-ssh',
      'destination.host': SSH_HOST,
      'destination.port': '22',
      'destination.username': 'vaultgate',
      'destination.host_key': HOST_KEYS.pinned,
      'credential.auth': 'key',
      'credential.key_field': 'sshKey.privateKey',
      'policy.allowed_commands': 'uptime',
      [ANY_COMMAND_FIELD]: 'on',
      'policy.timeout_ms': '30000',
      'policy.max_output_bytes': '262144',
      'policy.rate_limit_per_minute': '60',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      'policy.any_command: VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND is off on this deployment',
    );
    expect(harness.actions.engine.targets.get(target.id)).toMatchObject({ revision: 1 });
  });

  it('ACT-88 accepts the same submission where the deployment allows it', async () => {
    const harness = createPagesHarness({
      allowAnyCommand: true,
      addresses: { [SSH_HOST]: ['93.184.216.34'] },
    });
    const { browser, csrf } = await signedInOperator(harness);
    const response = await browser.submit('/account/actions', {
      csrf,
      connector: 'ssh',
      name: 'build-host',
      description: 'The build server',
      'credential.item_id': 'item-ssh',
      'destination.host': SSH_HOST,
      'destination.port': '22',
      'destination.username': 'vaultgate',
      'destination.host_key': HOST_KEYS.pinned,
      'credential.auth': 'key',
      'credential.key_field': 'sshKey.privateKey',
      'policy.allowed_commands': '',
      [ANY_COMMAND_FIELD]: 'on',
      'policy.timeout_ms': '30000',
      'policy.max_output_bytes': '262144',
      'policy.rate_limit_per_minute': '60',
    });
    expect(response.status).toBe(303);
    expect(harness.actions.engine.targets.list()[0]).toMatchObject({ name: 'build-host' });
  });

  it('ACT-2 ACT-6 creates an ssh target from the form and shows it with its destination summary', async () => {
    const harness = createPagesHarness({ addresses: { [SSH_HOST]: ['93.184.216.34'] } });
    const { browser, csrf } = await signedInOperator(harness);
    const response = await browser.submit('/account/actions', {
      csrf,
      connector: 'ssh',
      name: 'build-host',
      description: 'The build server',
      'credential.item_id': 'item-ssh',
      'destination.host': SSH_HOST,
      'destination.port': '22',
      'destination.username': 'vaultgate',
      'destination.host_key': HOST_KEYS.pinned,
      'credential.auth': 'key',
      'credential.key_field': 'sshKey.privateKey',
      'policy.allowed_commands': 'uptime',
      'policy.timeout_ms': '30000',
      'policy.max_output_bytes': '262144',
      'policy.rate_limit_per_minute': '60',
    });
    expect(response.status).toBe(303);
    const [created] = harness.actions.engine.targets.list();
    expect(created).toMatchObject({
      name: 'build-host',
      connector: 'ssh',
      state: 'valid',
      destinationSummary: 'vaultgate@build.example.com:22',
    });
  });

  it('ACT-6 reports a host key the operator mistyped rather than saving it', async () => {
    const harness = createPagesHarness({ addresses: { [SSH_HOST]: ['93.184.216.34'] } });
    const { browser, csrf } = await signedInOperator(harness);
    const response = await browser.submit('/account/actions', {
      csrf,
      connector: 'ssh',
      name: 'build-host',
      'credential.item_id': 'item-ssh',
      'destination.host': SSH_HOST,
      'destination.username': 'vaultgate',
      'destination.host_key': 'trust me',
      'credential.auth': 'key',
      'policy.allowed_commands': 'uptime',
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      'must be a public key line as ssh-keyscan prints it, or a SHA256: fingerprint',
    );
    expect(harness.actions.engine.targets.list()).toStrictEqual([]);
  });

  it('ACT-88 shows a standing warning on a saved any-command target and none on a restricted one', async () => {
    const harness = createPagesHarness({
      allowAnyCommand: true,
      addresses: { [SSH_HOST]: ['93.184.216.34'] },
    });
    const restricted = await createSshTarget(harness.actions);
    const unrestricted = await createSshTarget(harness.actions, {
      name: 'jump-host',
      policy: { allowed_commands: [], any_command: true },
    });
    expect(await markup(harness, `/account/actions/${unrestricted.id}`)).toContain(
      'This connection allows any command',
    );
    expect(await markup(harness, `/account/actions/${restricted.id}`)).not.toContain(
      'This connection allows any command',
    );
  });
});
