/**
 * `vault:generate` tools: fresh random credentials that are never stored and
 * touch no vault item.
 */
import { z } from 'zod';

import { ok } from '../../result.ts';

import { defineTool, type Tool, type ToolRun } from './definition.ts';

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
export const DEFAULT_PASSWORD_LENGTH = 24;
const MIN_WORDS = 3;
const MAX_WORDS = 20;
const DEFAULT_WORDS = 4;

const GENERATE = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const passwordInput = z.strictObject({
  length: z
    .number()
    .int()
    .min(MIN_PASSWORD_LENGTH)
    .max(MAX_PASSWORD_LENGTH)
    .default(DEFAULT_PASSWORD_LENGTH),
  uppercase: z.boolean().default(true),
  lowercase: z.boolean().default(true),
  numbers: z.boolean().default(true),
  special: z.boolean().default(true),
});
const passwordOutput = z.strictObject({ password: z.string() });

const runGeneratePassword: ToolRun<typeof passwordInput, typeof passwordOutput> = async (
  vault,
  input,
) => {
  const result = await vault.generatePassword(input);
  return result.ok ? ok({ password: result.value }) : result;
};

export const toolGeneratePassword: Tool = defineTool({
  name: 'generate_password',
  description:
    'Generates one random password of the requested length and character classes and returns ' +
    'it. Nothing is stored: to save it, pass generate_password: true to create_item or ' +
    'update_item instead, which fills the password without returning it to you.',
  annotations: { ...GENERATE, title: 'Generate password' },
  inputSchema: passwordInput,
  outputSchema: passwordOutput,
  run: runGeneratePassword,
});

const passphraseInput = z.strictObject({
  words: z.number().int().min(MIN_WORDS).max(MAX_WORDS).default(DEFAULT_WORDS),
  separator: z.string().min(1).max(1).default('-'),
  capitalize: z.boolean().default(false),
  include_number: z.boolean().default(false),
});
const passphraseOutput = z.strictObject({ passphrase: z.string() });

const runGeneratePassphrase: ToolRun<typeof passphraseInput, typeof passphraseOutput> = async (
  vault,
  input,
) => {
  const result = await vault.generatePassphrase({
    words: input.words,
    separator: input.separator,
    capitalize: input.capitalize,
    includeNumber: input.include_number,
  });
  return result.ok ? ok({ passphrase: result.value }) : result;
};

export const toolGeneratePassphrase: Tool = defineTool({
  name: 'generate_passphrase',
  description:
    'Generates one random Diceware-style passphrase with the requested word count, separator, ' +
    'capitalisation and optional digit, and returns it. Nothing is stored.',
  annotations: { ...GENERATE, title: 'Generate passphrase' },
  inputSchema: passphraseInput,
  outputSchema: passphraseOutput,
  run: runGeneratePassphrase,
});
