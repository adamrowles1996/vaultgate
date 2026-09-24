/**
 * `winrm_run` as the connector declares it (spec §13.6.5): the shared command
 * arguments of ACT-27 with the words this connector needs, the strict result,
 * the LLM-facing description (ACT-17) and the annotations of the 13.6.1 row
 * (ACT-18). The MCP layer puts `target` in front of the arguments.
 */
import { commandArguments, commandOutput, type CommandOperation } from '../command.ts';

import type { OutputSchema } from '../../../mcp/tools/definition.ts';
import type { ConnectorTool } from '../connector.ts';

export const WINRM_RUN_TOOL = 'winrm_run';

export const winrmRunSchema = commandArguments({
  command:
    'The command to run on the Windows host. On a PowerShell target it is one PowerShell ' +
    'script, sent as an encoded command, so no shell re-parses it; on a cmd target it is the ' +
    'command line cmd.exe will parse. It is matched whole against the allowlist, so write it ' +
    'exactly as the operator allowed it. A newline or carriage return is refused unless the ' +
    'target is an any-command one.',
  stdin:
    'Optional standard input, written to the command and then closed, so a command that reads ' +
    'until end of file finishes. At most 64 KiB.',
});

export type WinrmOperation = CommandOperation;

export const winrmRunOutputSchema: OutputSchema = commandOutput(
  'The exit status the command ended with, or null when the shell ended without one.',
);

export const WINRM_RUN_DESCRIPTION =
  'Runs one command on a Windows host the operator configured, over WinRM (WS-Management), ' +
  'signed in with a credential from the vault that you never see. `target` must be a ' +
  'name returned by actions_list_targets. `command` is matched in full against the commands the ' +
  'operator allowed on that target; anything else is refused with policy_denied (reason command) ' +
  'before any connection is opened, so ask the operator rather than guessing variations. A ' +
  'target the operator marked unrestricted accepts any command. The target says which shell ' +
  'runs it: a PowerShell target takes one PowerShell script, sent as an encoded command so ' +
  'quoting never changes it; a cmd target takes a cmd.exe command line. Optional `stdin` is ' +
  'written to the command and closed. One remote shell is created for the call and deleted when ' +
  'it ends; there is no session, so nothing (no directory, no variable, no background process) ' +
  'survives to the next call. Returns the exit code, standard output and standard error ' +
  'separately, whether either was cut at the output limit of the target, and the duration. It ' +
  'never returns the credential: any echo of it is replaced by [redacted:<field>]. The operator ' +
  'may require a human to confirm each call, which you cannot answer yourself: your client has ' +
  'to ask a person. A host whose certificate is not the pinned one is tls_error and nothing is ' +
  'sent to it.';

export const winrmRunTool: ConnectorTool<WinrmOperation> = {
  name: WINRM_RUN_TOOL,
  scope: 'actions:winrm',
  description: WINRM_RUN_DESCRIPTION,
  annotations: {
    title: 'WinRM command',
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: winrmRunSchema,
  outputSchema: winrmRunOutputSchema,
};
