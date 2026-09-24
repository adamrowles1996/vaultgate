/**
 * What the two command connectors share (§13.6.5, §14.5, §14.6). `ssh` and
 * `winrm` differ in how a command reaches the host; they do not differ in
 * what an agent may ask for (ACT-27), what an operator may allow (ACT-88) or
 * how the policy judges a command before anything connects (ACT-39). That
 * half lives here, so the two connectors cannot drift apart, and each
 * supplies only its own words: the protocol-specific help on the arguments,
 * the meaning of a missing exit status and its own scope.
 */
import { z } from 'zod';

import { commonPolicySchema, isPatternMatch } from '../policy.ts';

import { hasControlCharacter, hasNul } from './control-characters.ts';
import { excerptOf } from './operation-summary.ts';

import type { OperationDescription, OperationSchema, TargetCapabilities } from './connector.ts';
import type { OutputSchema } from '../../mcp/tools/definition.ts';
import type { ActionScope } from '../../scopes/registry.ts';
import type { PolicyDecision, PolicyReason } from '../policy.ts';

export const MAX_COMMAND_BYTES = 16 * 1024;

const MAX_STDIN_BYTES = 64 * 1024;
const LINE_BREAK = /[\n\r]/u;

/**
 * ACT-35: the characters that make a command line into a program rather than
 * a command. `;` separates statements, `&` backgrounds and forms `&&`, `|`
 * pipes, a backtick substitutes in a POSIX shell and escapes in PowerShell,
 * `$` opens `$(…)` and `${…}` in both, `<` and `>` redirect, and `(`/`)` open
 * a subshell in a POSIX shell and a sub-expression PowerShell evaluates
 * before the command runs. An allowlist pattern cannot restrain any of them:
 * `*` matches a run of characters, and every one of these is a character, so
 * a single wildcard turned `journalctl --since *` into an unrestricted shell.
 * A target that genuinely wants them is an `any_command` target, which ACT-88
 * gates on the deployment switch, the standing warning, `unrestricted: true`
 * and the full command in the trail.
 */
const SHELL_METACHARACTERS = /[;&|`$<>()]/u;

/**
ACT-27: the arguments of `ssh_run` and `winrm_run` past `target`.
*/
export interface CommandOperation {
  readonly command: string;
  readonly stdin?: string | undefined;
}

export interface CommandHelp {
  readonly command: string;
  readonly stdin: string;
}

/**
ACT-27: at most 16 KiB, never a NUL byte and never another control character, whichever connector carries it.
*/
function commandIssues(command: string, context: z.RefinementCtx): void {
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
    context.addIssue({ code: 'custom', message: 'must be at most 16 KiB' });
  }
  if (hasNul(command)) {
    context.addIssue({ code: 'custom', message: 'must not contain a NUL byte' });
  } else if (hasControlCharacter(command)) {
    context.addIssue({
      code: 'custom',
      message: 'must not contain a control character other than tab, carriage return or newline',
    });
  }
}

/**
The tool's arguments minus `target`, with the connector's own help on each field (ACT-17).
*/
export function commandArguments(help: CommandHelp): OperationSchema<CommandOperation> {
  return z.strictObject({
    command: z.string().min(1).superRefine(commandIssues).describe(help.command),
    stdin: z.string().max(MAX_STDIN_BYTES).optional().describe(help.stdin),
  });
}

/**
ACT-27: the same five fields for both tools; only what a missing exit status means differs.
*/
export function commandOutput(exitCodeHelp: string): OutputSchema {
  return z.strictObject({
    exit_code: z.number().int().nullable().describe(exitCodeHelp),
    stdout: z.string().describe('Everything the command wrote to standard output.'),
    stderr: z.string().describe('Everything the command wrote to standard error.'),
    truncated: z
      .boolean()
      .describe(
        'True when either stream was longer than the output limit of the target and was cut.',
      ),
    duration_ms: z.number().int(),
  });
}

export const commandPolicySchema = commonPolicySchema.extend({
  allowed_commands: z.array(z.string().min(1)).default([]),
  /**
  ACT-88: accepted at save only on a deployment with `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND=true`.
  */
  any_command: z.boolean().default(false),
});

export type CommandPolicy = z.output<typeof commandPolicySchema>;

/**
ACT-35: a pattern holding a metacharacter can never match, because no command holding one is allowed.
*/
function unmatchablePattern(patterns: readonly string[]): string | undefined {
  const found = patterns.find((pattern) => SHELL_METACHARACTERS.test(pattern));
  return found === undefined
    ? undefined
    : `policy.allowed_commands: the pattern "${found}" can never match, because a command on a ` +
        'restricted target may not contain ; & | ` $ < > ( or ); set any_command for a target ' +
        'that needs a shell';
}

/**
 * ACT-88: exactly one of the two; a target with neither would allow nothing
 * and is a mistake, not a lock. ACT-35: nor may a pattern hold a
 * metacharacter the runtime refuses, which would be a rule the operator
 * believes in and the engine can never satisfy.
 */
export function commandPolicyProblems(policy: CommandPolicy): readonly string[] {
  if (policy.any_command) {
    return policy.allowed_commands.length === 0
      ? []
      : ['policy: set either allowed_commands or any_command, not both'];
  }
  if (policy.allowed_commands.length === 0) {
    return ['policy.allowed_commands: give at least one command pattern, or set any_command'];
  }
  const unmatchable = unmatchablePattern(policy.allowed_commands);
  return unmatchable === undefined ? [] : [unmatchable];
}

export interface CommandDeployment {
  /**
  ACT-88: `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND`, read once when the connector is loaded.
  */
  readonly allowAnyCommand: boolean;
}

/**
 * ACT-39: `command_size` for a command beyond the 16 KiB of ACT-27 (the
 * tool's own schema refuses one too, so this is the second of two locks),
 * `command_metacharacter` for a shell operator on a target that is not an
 * any-command one, and `command` for a line break the target does not allow
 * and for a command no pattern matches. The metacharacter rule comes before
 * the patterns deliberately: it is what makes an allowlist mean what an
 * operator reads it to mean, so the refusal says so rather than hiding
 * behind "no pattern matched".
 */
function refusal(
  policy: CommandPolicy,
  command: string,
  deployment: CommandDeployment,
): PolicyReason | undefined {
  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
    return 'command_size';
  }
  if (policy.any_command) {
    return deployment.allowAnyCommand ? undefined : 'command';
  }
  if (LINE_BREAK.test(command)) {
    return 'command';
  }
  if (SHELL_METACHARACTERS.test(command)) {
    return 'command_metacharacter';
  }
  return policy.allowed_commands.some((pattern) => isPatternMatch(pattern, command, 'command'))
    ? undefined
    : 'command';
}

/**
 * The pure decision of ACT-39 (ACT-78). Every call is a `shell` operation
 * (ACT-40), so `confirm_writes` applies to all of them. §13.14 says turning
 * `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND` off makes an any-command target
 * refuse every call rather than quietly keep working, so the deployment is
 * closed over here.
 */
export function createCommandAuthorize(
  deployment: CommandDeployment,
): (policy: CommandPolicy, operation: CommandOperation) => PolicyDecision {
  return (policy, operation) => {
    const reason = refusal(policy, operation.command, deployment);
    return reason === undefined
      ? { allowed: true, operation: 'shell' }
      : { allowed: false, reason };
  };
}

/**
 * ACT-43: the command as the agent wrote it, as an excerpt when it is long
 * and never silently. ACT-60: the class the engine audits is the word
 * `command`, except on an any-command target, where ACT-88 wants the whole
 * command recorded and the 4 KiB cap on `arguments` could cut it. The engine
 * scrubs both (ACT-61).
 */
export function describeCommand(
  policy: CommandPolicy,
  operation: CommandOperation,
): OperationDescription {
  return {
    ...excerptOf(operation.command),
    classification: policy.any_command ? operation.command : 'command',
  };
}

/**
 * ACT-19, ACT-88: a command target offers the one `shell` operation and says
 * when it is unrestricted. An any-command target on a deployment that no
 * longer allows one offers nothing, so agents stop seeing it the moment the
 * switch goes off (§13.14).
 */
export function createCommandCapabilities(
  deployment: CommandDeployment,
  scope: ActionScope,
): (policy: CommandPolicy) => TargetCapabilities {
  return (policy) => {
    const isRefused = policy.any_command && !deployment.allowAnyCommand;
    return {
      operations: isRefused ? [] : [{ operation: 'shell', scope }],
      ...(policy.any_command && { unrestricted: true }),
    };
  };
}
