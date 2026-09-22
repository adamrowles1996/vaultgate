/**
 * `get_secret`: the only tool that returns a secret value (MCP-9), one field
 * per call, audited with the item id and field name (MCP-13).
 */
import { z } from 'zod';

import { fail, ok } from '../../result.ts';

import { defineTool, READ_ONLY, type Tool, ToolError, type ToolRun } from './definition.ts';
import { itemIdSchema } from './schemas.ts';

import type { SecretField } from '../../vault/client.ts';

const FIXED_FIELDS: Readonly<Record<string, SecretField>> = {
  password: { kind: 'password' },
  totp: { kind: 'totp' },
  notes: { kind: 'notes' },
  'card.number': { kind: 'card', field: 'number' },
  'card.code': { kind: 'card', field: 'code' },
  'sshKey.privateKey': { kind: 'sshKey', field: 'privateKey' },
};

const IDENTITY_PREFIX = 'identity.';
const CUSTOM_PREFIX = 'custom.';

/**
Parses the `field` argument into the vault contract's discriminated union.
*/
export function parseSecretField(text: string): SecretField | undefined {
  const fixed = FIXED_FIELDS[text];
  if (fixed !== undefined) {
    return fixed;
  }
  if (text.startsWith(IDENTITY_PREFIX) && text.length > IDENTITY_PREFIX.length) {
    return { kind: 'identity', field: text.slice(IDENTITY_PREFIX.length) };
  }
  return text.startsWith(CUSTOM_PREFIX) && text.length > CUSTOM_PREFIX.length
    ? { kind: 'customField', name: text.slice(CUSTOM_PREFIX.length) }
    : undefined;
}

const secretInput = z.strictObject({
  item_id: itemIdSchema,
  field: z.string().min(1).describe('Which secret field to reveal; see the tool description.'),
});

const textSecret = z.strictObject({ kind: z.literal('text'), value: z.string() });
const totpSecret = z.strictObject({
  kind: z.literal('totp'),
  code: z.string(),
  seconds_remaining: z.number().int().nonnegative(),
});
const secretOutput = z.discriminatedUnion('kind', [textSecret, totpSecret]);

const runGetSecret: ToolRun<typeof secretInput, typeof secretOutput> = async (vault, input) => {
  const field = parseSecretField(input.field);
  if (field === undefined) {
    return fail(new ToolError('invalid_field', `"${input.field}" is not a secret field name`));
  }
  const result = await vault.getSecret(input.item_id, field);
  if (!result.ok) {
    return result;
  }
  const secret = result.value;
  return ok(
    secret.kind === 'totp'
      ? { kind: 'totp' as const, code: secret.code, seconds_remaining: secret.secondsRemaining }
      : { kind: 'text' as const, value: secret.value },
  );
};

export const toolGetSecret: Tool = defineTool({
  name: 'get_secret',
  description:
    'Returns the value of exactly one secret field of one item. This is the only tool that ' +
    'returns secret material; every call is audited with the item id and field name. `field` is ' +
    'one of: "password", "totp" (the current code and its remaining seconds, never the seed), ' +
    '"notes" (secure note body or login notes), "card.number", "card.code", ' +
    '"identity.<field>" (for example "identity.ssn"), "sshKey.privateKey", or ' +
    '"custom.<name>" for a hidden custom field named in get_item. Use search_items or get_item ' +
    'first to find the item id and which fields are present.',
  annotations: { ...READ_ONLY, title: 'Get secret' },
  inputSchema: secretInput,
  outputSchema: secretOutput,
  auditReference: (input) => ({ itemId: input.item_id, field: input.field }),
  run: runGetSecret,
});
