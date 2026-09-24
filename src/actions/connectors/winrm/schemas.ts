/**
 * The `winrm` connector's target documents (spec §14.6). The schemas are the
 * static half every build carries so the account page can validate and edit
 * targets; the runtime is `./index.ts`. The endpoint is an HTTPS WS-Management
 * URL — a plain one only on an `internal` target, which the save-time check of
 * `targets-checks.ts` insists on and warns about — and it may pin the leaf
 * certificate the listener presents (ACT-57), which is what a host with its own
 * certificate needs. The policy is the shared command policy of `../command.ts`
 * (ACT-88).
 */
import { z } from 'zod';

import { commandPolicyProblems, commandPolicySchema, type CommandPolicy } from '../command.ts';

import type { ConnectorSchemas, CredentialField, Endpoint } from '../connector.ts';

export const WINRM_SHELLS = ['powershell', 'cmd'] as const;

const SHA256_HEX = /^[\da-f]{64}$/u;
const SEPARATORS = /[\s:]/gu;

/**
Why the endpoint is refused, or `undefined` when it is acceptable.
*/
export function urlProblem(text: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return 'must be an absolute URL, such as https://host:5986/wsman';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'must be an https:// (or, on an internal target, http://) URL';
  }
  if (url.search !== '' || url.hash !== '') {
    return 'must not carry a query string or fragment';
  }
  return url.username === '' && url.password === '' ? undefined : 'must not carry credentials';
}

const urlSchema = z.string().superRefine((text, context) => {
  const problem = urlProblem(text);
  if (problem !== undefined) {
    context.addIssue({ code: 'custom', message: problem });
  }
});

/**
 * ACT-57: the SHA-256 of the DER leaf certificate, as `openssl` and
 * `Get-FileHash` print it — with or without the colons, in either case. It is
 * stored in one form so the comparison at connect time is a string equality.
 */
const certificateSchema = z
  .string()
  .transform((text, context) => {
    const digest = text.replaceAll(SEPARATORS, '').toLowerCase();
    if (SHA256_HEX.test(digest)) {
      return digest;
    }
    context.addIssue({
      code: 'custom',
      message: 'must be a SHA-256 fingerprint: 64 hexadecimal digits, colons optional',
    });
    return z.NEVER;
  })
  .optional();

export const winrmDestinationSchema = z.strictObject({
  url: urlSchema,
  /**
  The account the command runs as; §14.6 puts it in the destination, so one vault item can serve several targets.
  */
  username: z.string().min(1),
  shell: z.enum(WINRM_SHELLS).default('powershell'),
  certificate_sha256: certificateSchema,
});

export const winrmCredentialSchema = z.strictObject({
  password_field: z.string().min(1).default('password'),
});

export const winrmPolicySchema = commandPolicySchema;

export type WinrmDestination = z.output<typeof winrmDestinationSchema>;
export type WinrmCredential = z.output<typeof winrmCredentialSchema>;
export type WinrmPolicy = CommandPolicy;

/**
ACT-57: `tls` is false for a plain endpoint, which then needs `internal: true` and carries a warning.
*/
function endpoints(destination: WinrmDestination): readonly Endpoint[] {
  const url = new URL(destination.url);
  return [{ host: url.hostname, tls: url.protocol === 'https:' }];
}

/**
 * The login name lives in the destination (§14.6), so nothing here has the
 * `username` role; `basicUsername` is what puts it in front of the scrubber.
 */
function credentialFields(credential: WinrmCredential): readonly CredentialField[] {
  return [{ name: credential.password_field, selector: credential.password_field, role: 'secret' }];
}

/**
A pin is a TLS control; on a plain endpoint it would be silently ignored, which is worse than a refusal.
*/
function certificateProblems(destination: WinrmDestination): readonly string[] {
  const isPinned = destination.certificate_sha256 !== undefined;
  return isPinned && new URL(destination.url).protocol === 'http:'
    ? ['destination.certificate_sha256: a certificate pin needs an https:// url']
    : [];
}

export const winrmSchemas: ConnectorSchemas<WinrmDestination, WinrmCredential, WinrmPolicy> = {
  kind: 'winrm',
  destinationSchema: winrmDestinationSchema,
  credentialSchema: winrmCredentialSchema,
  policySchema: winrmPolicySchema,
  endpoints,
  credentialFields,
  /**
   * ACT-51: `client.ts` authenticates with `Basic
   * base64(destination.username:password)`, a string vaultgate builds itself,
   * so the engine needs the account name to generate that variant. Without it
   * a listener that echoed the `Authorization` header would return the pair
   * the agent can decode, with only the raw password redacted.
   */
  basicUsername(destination) {
    return destination.username;
  },
  saveProblems({ destination, policy }) {
    return [...certificateProblems(destination), ...commandPolicyProblems(policy)];
  },
  summariseDestination(destination) {
    return `${destination.username}@${new URL(destination.url).host} (${destination.shell})`;
  },
  /**
  ACT-49: running a command is never a read, whatever the command is.
  */
  allowsNonRead() {
    return true;
  },
};
