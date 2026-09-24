import { describe, expect, it } from 'vitest';

import { commandArguments, MAX_COMMAND_BYTES } from './command.ts';

import type { z } from 'zod';

const SCHEMA = commandArguments({ command: 'the command', stdin: 'the input' });

function problemsOf(parsed: z.ZodSafeParseResult<unknown>): readonly string[] {
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

function problemsFor(input: Readonly<Record<string, unknown>>): readonly string[] {
  return problemsOf(SCHEMA.safeParse(input));
}

describe('the shared command arguments', () => {
  it('ACT-27 accepts a command with a tab and, for an any-command target, a newline', () => {
    expect(SCHEMA.parse({ command: 'echo\tone\ntwo\r' })).toStrictEqual({
      command: 'echo\tone\ntwo\r',
    });
  });

  it('ACT-27 refuses a NUL byte, and says so once', () => {
    expect(problemsFor({ command: 'up\u{0}time' })).toStrictEqual(['must not contain a NUL byte']);
  });

  it('ACT-27 refuses another control character, which no XML envelope could carry', () => {
    expect(problemsOf(SCHEMA.safeParse({ command: 'echo \u{1B}[31m' }))).toStrictEqual([
      'must not contain a control character other than tab, carriage return or newline',
    ]);
  });

  it('ACT-27 refuses a command beyond 16 KiB, an empty one and standard input beyond 64 KiB', () => {
    expect(problemsFor({ command: 'x'.repeat(MAX_COMMAND_BYTES + 1) })).toStrictEqual([
      'must be at most 16 KiB',
    ]);
    expect(problemsFor({ command: '' })).toHaveLength(1);
    expect(problemsFor({ command: 'ok', stdin: 'x'.repeat(64 * 1024 + 1) })).toHaveLength(1);
    expect(problemsFor({ command: 'ok', extra: 1 })).toHaveLength(1);
  });
});
