/**
 * `ssh_run` as the connector declares it (spec §13.6.5): the operation
 * arguments the engine parses (ACT-27), the strict result, the LLM-facing
 * description (ACT-17) and the annotations of the 13.6.1 row (ACT-18). The
 * MCP layer puts `target` in front of the arguments.
 */
import { z } from 'zod';

import type { OutputSchema } from '../../../mcp/tools/definition.ts';
import type { ConnectorTool } from '../connector.ts';

export const SSH_RUN_TOOL = 'ssh_run';

export const MAX_COMMAND_BYTES = 16 * 1024;

const MAX_STDIN_BYTES = 64 * 1024;
const NUL = '\u{0}';

const commandSchema = z
  .string()
  .min(1)
  .superRefine((command, context) => {
    if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
      context.addIssue({ code: 'custom', message: 'must be at most 16 KiB' });
    }
    if (command.includes(NUL)) {
      context.addIssue({ code: 'custom', message: 'must not contain a NUL byte' });
    }
  })
  .describe(
    'The command line to run, as the login shell of the target account will parse it. It is ' +
      'matched whole against the allowlist, so write it exactly as the operator allowed it. A ' +
      'newline or carriage return is refused unless the target is an any-command one.',
  );

const stdinSchema = z
  .string()
  .max(MAX_STDIN_BYTES)
  .optional()
  .describe(
    'Optional standard input, written to the command and then closed, so a command that reads ' +
      'until end of file finishes. At most 64 KiB.',
  );

export const sshRunSchema = z.strictObject({ command: commandSchema, stdin: stdinSchema });

export type SshOperation = z.output<typeof sshRunSchema>;

export const sshRunOutputSchema: OutputSchema = z.strictObject({
  exit_code: z
    .number()
    .int()
    .nullable()
    .describe(
      'The exit status the command ended with, or null when the channel closed without one.',
    ),
  stdout: z.string().describe('Everything the command wrote to standard output.'),
  stderr: z.string().describe('Everything the command wrote to standard error.'),
  truncated: z
    .boolean()
    .describe(
      'True when either stream was longer than the output limit of the target and was cut.',
    ),
  duration_ms: z.number().int(),
});

export const SSH_RUN_DESCRIPTION =
  'Runs one command on a server the operator configured, over SSH, signed in with a credential ' +
  'from the vault that you never see. `target` must be a name returned by actions_list_targets. ' +
  '`command` is matched in full against the commands the operator allowed on that target; ' +
  'anything else is refused with policy_denied (reason command) before any connection is ' +
  'opened, so ask the operator rather than guessing variations. A target the operator marked ' +
  'unrestricted accepts any command. Optional `stdin` is written to the command and closed. ' +
  'The command runs in one exec channel with no terminal, no agent forwarding and no ' +
  'environment vaultgate sets; there is no session, so nothing (no directory, no variable, no ' +
  'background process) survives to the next call. Returns the exit code, standard output and ' +
  'standard error separately, whether either was cut at the output limit of the target, and ' +
  'the duration. It never returns the credential: any echo of it is replaced by [redacted:<field>]. ' +
  'The operator may require a human to confirm each call, which you cannot answer yourself: ' +
  'your client has to ask a person. A server whose host key does not match the pinned one is ' +
  'host_key_mismatch and nothing is sent to it.';

export const sshRunTool: ConnectorTool<SshOperation> = {
  name: SSH_RUN_TOOL,
  scope: 'actions:ssh',
  description: SSH_RUN_DESCRIPTION,
  annotations: {
    title: 'SSH command',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: sshRunSchema,
  outputSchema: sshRunOutputSchema,
};
