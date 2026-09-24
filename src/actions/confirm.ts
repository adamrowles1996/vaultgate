/**
 * Confirmation through elicitation (spec §13.8): the `requestState` of
 * ACT-44 minted and verified here (ACT-45), the `ElicitResult` handling of
 * ACT-47 and the exact elicitation request document of ACT-42. The transport
 * (returning `InputRequiredResult`, reading `inputResponses`) is the MCP
 * layer's job; this module is transport-neutral.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

import { ACTIONS_CONFIRMATION_INFO, deriveKey } from '../crypto/secret-box.ts';
import { fail, ok, type Result } from '../result.ts';

import { ActionError } from './errors.ts';

import type { OmittedText } from './connectors/operation-summary.ts';

export const CONFIRMATION_TTL_MS = 120_000;
const NONCE_BYTES = 16;
const STATE_PARTS = 2;

const payloadSchema = z.strictObject({
  v: z.literal(1),
  nonce: z.string().min(1),
  target_id: z.string(),
  revision: z.number().int(),
  tool: z.string(),
  client_id: z.string(),
  token_prefix: z.string(),
  args_sha256: z.string(),
  issued_at: z.number().int(),
  expires_at: z.number().int(),
});

export type ConfirmationPayload = z.output<typeof payloadSchema>;

/**
What a confirmation is bound to: the call it was minted for and nothing else.
*/
export type ConfirmationBinding = Pick<
  ConfirmationPayload,
  'target_id' | 'revision' | 'tool' | 'client_id' | 'token_prefix' | 'args_sha256'
>;

export interface ConfirmationDependencies {
  readonly secretKey: Buffer;
  readonly random: (bytes: number) => Buffer;
  readonly now: () => number;
}

export interface Confirmations {
  mint(binding: ConfirmationBinding): { readonly requestState: string; readonly nonce: string };
  verify(
    requestState: string,
    binding: ConfirmationBinding,
  ): Result<ConfirmationPayload, ActionError>;
}

/**
 * Canonical JSON: object keys sorted at every level, arrays in order, the
 * standard scalar serialisation, `undefined` properties dropped. Defined
 * once so `args_sha256` means the same thing at mint and at verify.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .toSorted(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export function argumentsDigest(argumentsValue: unknown): string {
  return createHash('sha256').update(canonicalJson(argumentsValue)).digest('hex');
}

function encode(payload: ConfirmationPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decode(text: string): ConfirmationPayload | undefined {
  try {
    const parsed = payloadSchema.safeParse(
      JSON.parse(Buffer.from(text, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function isBoundTo(payload: ConfirmationPayload, binding: ConfirmationBinding): boolean {
  return (
    payload.client_id === binding.client_id &&
    payload.token_prefix === binding.token_prefix &&
    payload.target_id === binding.target_id &&
    payload.revision === binding.revision &&
    payload.tool === binding.tool &&
    payload.args_sha256 === binding.args_sha256
  );
}

/**
 * ACT-44: `base64url(payload) + "." + base64url(HMAC-SHA256(payload))` under
 * a key derived from `VAULTGATE_SECRET_KEY`; 16-byte nonce; 120 s lifetime.
 */
export function createConfirmations(dependencies: ConfirmationDependencies): Confirmations {
  const key = deriveKey(dependencies.secretKey, ACTIONS_CONFIRMATION_INFO);
  const sign = (encoded: string): Buffer => createHmac('sha256', key).update(encoded).digest();
  return {
    mint(binding) {
      const issuedAt = dependencies.now();
      const nonce = dependencies.random(NONCE_BYTES).toString('base64url');
      const encoded = encode({
        v: 1,
        nonce,
        ...binding,
        issued_at: issuedAt,
        expires_at: issuedAt + CONFIRMATION_TTL_MS,
      });
      return { requestState: `${encoded}.${sign(encoded).toString('base64url')}`, nonce };
    },
    verify(requestState, binding) {
      const parts = requestState.split('.');
      const [encoded, signature] = parts;
      if (encoded === undefined || signature === undefined || parts.length !== STATE_PARTS) {
        return fail(new ActionError('confirmation_invalid'));
      }
      const expected = sign(encoded);
      const presented = Buffer.from(signature, 'base64url');
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
        return fail(new ActionError('confirmation_invalid'));
      }
      const payload = decode(encoded);
      if (payload === undefined) {
        return fail(new ActionError('confirmation_invalid'));
      }
      if (dependencies.now() >= payload.expires_at) {
        return fail(new ActionError('confirmation_expired'));
      }
      return isBoundTo(payload, binding)
        ? ok(payload)
        : fail(new ActionError('confirmation_invalid'));
    },
  };
}

/**
The client's answer to the elicitation, as the MCP `ElicitResult` carries it.
*/
export type ElicitResult =
  | { readonly action: 'accept'; readonly content?: Readonly<Record<string, unknown>> | undefined }
  | { readonly action: 'decline' }
  | { readonly action: 'cancel' };

export type ElicitationOutcome = 'accepted' | 'declined' | 'cancelled';

/**
ACT-47: only `accept` with `confirm === true` runs the call.
*/
export function elicitationOutcome(result: ElicitResult): ElicitationOutcome {
  switch (result.action) {
    case 'accept': {
      return result.content?.['confirm'] === true ? 'accepted' : 'declined';
    }
    case 'decline': {
      return 'declined';
    }
    case 'cancel': {
      return 'cancelled';
    }
  }
}

export interface ConfirmationRequestInput {
  readonly clientName: string;
  readonly tool: string;
  readonly targetName: string;
  readonly connector: string;
  /**
  ACT-43: host (and database, base path or origin) only.
  */
  readonly destinationSummary: string;
  /**
  ACT-43: already scrubbed by the caller.
  */
  readonly operationSummary: string;
  /**
  ACT-43: what the excerpt leaves out, said outside the quoted block so the agent cannot suppress it.
  */
  readonly omitted?: OmittedText | undefined;
}

const QUOTE = '> ';
const LINE_TERMINATOR = /\r\n|[\n\r]/u;

/**
 * ACT-43: every line of the operation carries the quote marker, and the
 * message says so. The summary is the agent's own text: without this it sits
 * between blank lines and can reproduce the prompt's trailer, so a call can
 * be made to look as though it ended before the operative clause. A line the
 * agent writes is a quoted line; the trailer is the only unquoted one, and
 * nothing the agent sends can produce an unquoted line.
 */
function quoted(summary: string): string {
  return summary
    .split(LINE_TERMINATOR)
    .map((line) => `${QUOTE}${line}`)
    .join('\n');
}

/**
ACT-43: the unforgeable half — vaultgate says what it did not show, and how to identify the whole of it.
*/
function omissionNotice(omitted: OmittedText | undefined): string {
  return omitted === undefined
    ? ''
    : `NOT SHOWN: ${String(omitted.characters)} of ${String(omitted.total)} characters are ` +
        `missing from the middle of the operation above. The SHA-256 of the whole of it is ` +
        `${omitted.sha256}. Do not approve an operation you have not read.\n\n`;
}

export interface ConfirmationRequest {
  readonly method: 'elicitation/create';
  readonly params: {
    readonly mode: 'form';
    readonly message: string;
    readonly requestedSchema: {
      readonly type: 'object';
      readonly properties: {
        readonly confirm: {
          readonly type: 'boolean';
          readonly title: 'Allow this call';
          readonly description: 'Tick to let vaultgate run the operation shown above, once.';
          readonly default: false;
        };
      };
      readonly required: readonly ['confirm'];
    };
  };
}

/**
ACT-42: the elicitation request, verbatim; ACT-43: the message template.
*/
export function buildConfirmationRequest(input: ConfirmationRequestInput): ConfirmationRequest {
  const message =
    `vaultgate: ${input.clientName} asks to run ${input.tool} on target "${input.targetName}" ` +
    `(${input.connector}, ${input.destinationSummary}).\n\n` +
    `The operation, every line of it quoted with "${QUOTE}":\n` +
    `${quoted(input.operationSummary)}\n\n` +
    omissionNotice(input.omitted) +
    'Allow this one call? It expires in 2 minutes and cannot be reused.';
  return {
    method: 'elicitation/create',
    params: {
      mode: 'form',
      message,
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            title: 'Allow this call',
            description: 'Tick to let vaultgate run the operation shown above, once.',
            default: false,
          },
        },
        required: ['confirm'],
      },
    },
  };
}
