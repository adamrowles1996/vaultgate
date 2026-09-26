/**
 * The `ssh` connector's form (spec §14.5): one descriptor per field of its
 * three documents, in the order the operator reads them. The `any_command`
 * box is drawn only on a deployment that allows it (ACT-88), which the
 * renderer knows nothing about: the descriptor names the switch it needs and
 * `forms.ts` leaves it out when the switch is off.
 */
import type { FieldDescriptor } from './descriptors.ts';

const SELECTOR_HELP =
  'A vault field: sshKey.privateKey, password, notes, or custom.<name> for a hidden custom field.';

const destination: readonly FieldDescriptor[] = [
  {
    document: 'destination',
    name: 'host',
    label: 'Host',
    kind: 'text',
    address: 'host',
    required: true,
    help: 'Resolved once per call; the connection goes to that address and nowhere else.',
  },
  {
    document: 'destination',
    name: 'port',
    label: 'Port',
    kind: 'number',
    min: 1,
    max: 65_535,
    fallback: 22,
    help: 'Default 22.',
  },
  {
    document: 'destination',
    name: 'username',
    label: 'Login name',
    kind: 'text',
    required: true,
    help: 'The account the command runs as. Give it its own least-privilege user on the server.',
  },
  {
    document: 'destination',
    name: 'host_key',
    label: 'Host key',
    kind: 'text',
    required: true,
    help:
      'The server public key line ssh-keyscan prints (ssh-keyscan -t ed25519 <host>), or its ' +
      'SHA256: fingerprint. Required: a server presenting any other key is refused before the ' +
      'credential is offered, and there is no trust-on-first-use.',
  },
];

const credential: readonly FieldDescriptor[] = [
  {
    document: 'credential',
    name: 'auth',
    label: 'Authentication',
    kind: 'select',
    options: [
      { value: 'key', label: 'key' },
      { value: 'password', label: 'password' },
    ],
    fallback: 'key',
    help: 'A private key from the vault item, or a password. A key is the better choice.',
  },
  {
    document: 'credential',
    name: 'key_field',
    label: 'Private key field',
    kind: 'text',
    picker: { role: 'secret', fallback: 'sshKey.privateKey' },
    when: { field: 'auth', values: ['key'] },
    help: `sshKey.privateKey unless another field holds it. ${SELECTOR_HELP}`,
  },
  {
    document: 'credential',
    name: 'passphrase_field',
    label: 'Key passphrase field',
    kind: 'text',
    picker: { role: 'secret', optional: true },
    when: { field: 'auth', values: ['key'] },
    help: `Optional; leave empty for a key with no passphrase. ${SELECTOR_HELP}`,
  },
  {
    document: 'credential',
    name: 'password_field',
    label: 'Password field',
    kind: 'text',
    picker: { role: 'secret', fallback: 'password' },
    when: { field: 'auth', values: ['password'] },
    help: `password unless another field holds it. ${SELECTOR_HELP}`,
  },
];

const policy: readonly FieldDescriptor[] = [
  {
    document: 'policy',
    name: 'allowed_commands',
    label: 'Allowed commands',
    kind: 'lines',
    fallback: [],
    help:
      'One pattern per line, matched against the whole command; * matches any run of characters ' +
      'except a newline. A pattern that would allow everything is refused: that is what the ' +
      'unrestricted box below is for.',
  },
  {
    document: 'policy',
    name: 'any_command',
    label: 'Allow any command (this connection becomes a shell)',
    kind: 'boolean',
    fallback: false,
    allowedBy: 'allowAnyCommand',
    help:
      'A granted client can then run anything this login can. Every call is audited with the ' +
      'full command. Leave the allowed commands empty when you tick this.',
  },
];

export const sshForm = {
  kind: 'ssh',
  fields: [...destination, ...credential, ...policy],
} as const;
