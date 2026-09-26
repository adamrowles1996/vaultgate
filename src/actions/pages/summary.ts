/**
 * One target as the console summarises it (ACT-5): its kind, its address in
 * two lines, the vault fields it signs in with (names only; every field but
 * `login.username` is secret and drawn sealed), what its policy allows and
 * whether a person confirms the rest (ACT-49), and its state. Read from the
 * validated documents (ACT-1); an invalid row shows what can still be said.
 */
import { z } from 'zod';

import { validateTarget } from '../targets-schemas.ts';

import { type ComputerKind, kindOf } from './kinds.ts';

import type { TargetSummary } from '../targets.ts';

export interface MappedField {
  readonly selector: string;
  readonly isSecret: boolean;
}

/**
 * ACT-49: `confirmed` when a person confirms every non-read call,
 * `unconfirmed` when non-read calls run without asking, `reads` when the
 * policy allows reads only and there is nothing to confirm.
 */
export type Confirmation = 'confirmed' | 'unconfirmed' | 'reads';

export type ComputerState = 'enabled' | 'disabled' | 'invalid';

export interface ComputerSummary {
  readonly kind: ComputerKind;
  readonly address: string;
  readonly addressDetail: string;
  readonly fields: readonly MappedField[];
  /**
  What it signs in with when it maps no field at all: a public repository read without a token.
  */
  readonly credentialNote?: string;
  readonly allows: string;
  readonly confirmation: Confirmation;
  readonly state: ComputerState;
}

const USERNAME_SELECTOR = 'login.username';

const sqlPolicy = z.object({ operations: z.array(z.string()) });
const commandPolicy = z.object({
  any_command: z.boolean().default(false),
  allowed_commands: z.array(z.string()).default([]),
});
const httpPolicy = z.object({ allowed_methods: z.array(z.string()) });
const codePolicy = z.object({ content: z.array(z.string()), allow_read: z.boolean() });
const codeDestination = z.object({ ref: z.string().optional() });

/**
ACT-119: a public repository read without a token signs in with nothing.
*/
const NO_TOKEN = 'No token: a public repository';

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

type Allows = (policy: unknown) => string | undefined;

function commandsAllowed(policy: unknown): string | undefined {
  const commands = commandPolicy.safeParse(policy);
  if (!commands.success) {
    return undefined;
  }
  return commands.data.any_command
    ? 'Any command'
    : plural(commands.data.allowed_commands.length, 'command');
}

/**
What each connector's policy allows, in a few words; `undefined` for a policy out of shape.
*/
const ALLOWS: Readonly<Partial<Record<TargetSummary['connector'], Allows>>> = {
  sql(policy) {
    const sql = sqlPolicy.safeParse(policy);
    if (!sql.success) {
      return;
    }
    return sql.data.operations.includes('write') ? 'Read and write' : 'Read only';
  },
  ssh: commandsAllowed,
  winrm: commandsAllowed,
  http(policy) {
    const http = httpPolicy.safeParse(policy);
    return http.success ? http.data.allowed_methods.join(', ') : undefined;
  },
  code(policy) {
    const code = codePolicy.safeParse(policy);
    if (!code.success) {
      return;
    }
    return [...code.data.content, ...(code.data.allow_read ? ['read files'] : [])].join(', ');
  },
};

/**
What the policy in force lets an agent do, in a few words; `policy` has its defaults filled in.
*/
export function allowsOf(connector: TargetSummary['connector'], policy: unknown): string {
  return ALLOWS[connector]?.(policy) ?? '';
}

/**
Where the destination is: the network and the transport, or for a repository which ref it follows.
*/
function addressDetailOf(target: TargetSummary, isEncrypted: boolean): string {
  const code = codeDestination.safeParse(target.destination);
  if (target.connector === 'code' && code.success) {
    return code.data.ref === undefined ? 'GitHub · default branch' : 'GitHub · configured ref';
  }
  const network = target.internal ? 'internal' : 'public';
  return `${network} · ${isEncrypted ? 'encrypted' : 'plain transport'}`;
}

function stateOf(target: TargetSummary): ComputerState {
  if (target.state === 'invalid') {
    return 'invalid';
  }
  return target.enabled ? 'enabled' : 'disabled';
}

export function summarise(target: TargetSummary): ComputerSummary {
  const validated = validateTarget(target);
  const base = {
    kind: kindOf(target),
    address: target.destinationSummary ?? 'not readable',
    state: stateOf(target),
  };
  if (validated.state === 'invalid') {
    return {
      ...base,
      addressDetail: 'not readable',
      allows: '',
      fields: [],
      confirmation: 'reads',
    };
  }
  const { documents, schemas } = validated;
  const isEncrypted = schemas.endpoints(documents.destination).every((endpoint) => endpoint.tls);
  const fields = schemas.credentialFields(documents.credential).map((field) => ({
    selector: field.selector,
    isSecret: field.selector !== USERNAME_SELECTOR,
  }));
  let confirmation: Confirmation = 'reads';
  if (schemas.allowsNonRead(documents.policy)) {
    confirmation = documents.common.confirm_writes ? 'confirmed' : 'unconfirmed';
  }
  return {
    ...base,
    addressDetail: addressDetailOf(target, isEncrypted),
    allows: allowsOf(target.connector, documents.policy),
    fields,
    ...(fields.length === 0 && target.connector === 'code' && { credentialNote: NO_TOKEN }),
    confirmation,
  };
}
