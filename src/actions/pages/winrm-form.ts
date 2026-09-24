/**
 * The `winrm` connector's form (spec §14.6): one descriptor per field of its
 * three documents, in the order the operator reads them. The `any_command`
 * box is drawn only on a deployment that allows it (ACT-88), which the
 * renderer knows nothing about: the descriptor names the switch it needs and
 * `forms.ts` leaves it out when the switch is off.
 */
import type { FieldDescriptor } from './descriptors.ts';

const destination: readonly FieldDescriptor[] = [
  {
    document: 'destination',
    name: 'url',
    label: 'WS-Management endpoint',
    kind: 'text',
    required: true,
    help:
      'https://host:5986/wsman for the HTTPS listener. A plain http:// endpoint sends the ' +
      'password in the clear and is accepted only on an internal target. The host is resolved ' +
      'once per call and the connection goes to that address and nowhere else.',
  },
  {
    document: 'destination',
    name: 'username',
    label: 'Login name',
    kind: 'text',
    required: true,
    help:
      'The account the command runs as, as Windows expects it (name, ' +
      String.raw`DOMAIN\name` +
      ' or name@domain). Give it its own least-privilege local user on the host.',
  },
  {
    document: 'destination',
    name: 'shell',
    label: 'Shell',
    kind: 'select',
    options: [
      { value: 'powershell', label: 'powershell' },
      { value: 'cmd', label: 'cmd' },
    ],
    fallback: 'powershell',
    help:
      'PowerShell runs the command as an encoded command, so no shell re-parses what the agent ' +
      'sent; cmd runs the command line through cmd.exe.',
  },
  {
    document: 'destination',
    name: 'certificate_sha256',
    label: 'Certificate fingerprint (SHA-256)',
    kind: 'text',
    help:
      'Optional. Leave empty to verify the listener against the system certificate store; give ' +
      'the SHA-256 of its certificate — 64 hexadecimal digits, colons optional — to pin that one ' +
      'certificate instead, which is what a host with its own certificate needs. A host ' +
      'presenting any other certificate fails the call with tls_error and nothing is sent to it.',
  },
];

const credential: readonly FieldDescriptor[] = [
  {
    document: 'credential',
    name: 'password_field',
    label: 'Password field',
    kind: 'text',
    help:
      'password unless another field holds it. A vault field: password, notes, or ' +
      'custom.<name> for a hidden custom field.',
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
    label: 'Allow any command (this target becomes a shell)',
    kind: 'boolean',
    fallback: false,
    allowedBy: 'allowAnyCommand',
    help:
      'A granted client can then run anything this login can. Every call is audited with the ' +
      'full command. Leave the allowed commands empty when you tick this.',
  },
];

export const winrmForm = {
  kind: 'winrm',
  fields: [...destination, ...credential, ...policy],
} as const;
