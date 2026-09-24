/**
 * One `winrm_run` on a Windows host (§14.6): the password read out of the
 * injected values (ACT-50), one WS-Management shell created against the
 * address the engine resolved and validated (ACT-55) and deleted in `finally`
 * (ACT-58), one command, and the two streams captured separately up to the
 * output limit plus the guard band (ACT-52). No pool and no session, so an
 * idle deployment holds nothing open and a rotated password takes effect on
 * the next call.
 */
import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import { messageOf, runFailure } from './failures.ts';

import type { WinrmOperation } from './operation.ts';
import type { WinrmCredential, WinrmDestination, WinrmPolicy } from './schemas.ts';
import type { WinrmConnection, WinrmSession, WinrmSessionFactory } from './session.ts';
import type { Logger } from '../../../logger.ts';
import type { ConnectorOutput, RunContext } from '../connector.ts';

export type WinrmRunContext = RunContext<WinrmDestination, WinrmCredential, WinrmPolicy>;

export type WinrmRun = (
  context: WinrmRunContext,
  operation: WinrmOperation,
) => Promise<Result<ConnectorOutput, ActionError>>;

/**
Everything the call needs before it connects; every refusal here happens with nothing open.
*/
function prepare(context: WinrmRunContext): Result<WinrmConnection, ActionError> {
  const [endpoint] = context.pinned;
  if (endpoint === undefined) {
    return fail(new ActionError('destination_refused', { reason: 'unpinned' }));
  }
  const password = context.injected.value(context.credential.password_field)?.toString('utf8');
  if (password === undefined) {
    return fail(new ActionError('credential_unavailable'));
  }
  const { destination } = context;
  return ok({
    url: destination.url,
    address: endpoint.address,
    username: destination.username,
    password,
    shell: destination.shell,
    certificateSha256: destination.certificate_sha256,
    signal: context.signal,
  });
}

/**
A shell that will not delete is logged for the operator; it never changes the call's outcome.
*/
async function closeQuietly(session: WinrmSession, logger: Logger): Promise<void> {
  try {
    await session.close();
  } catch (error: unknown) {
    logger.warn({ reason: messageOf(error) }, 'the winrm shell did not delete cleanly');
  }
}

/**
`run` of the `winrm` connector over an injected session factory (ACT-78).
*/
export function createRun(open: WinrmSessionFactory): WinrmRun {
  return async (context, operation) => {
    const prepared = prepare(context);
    if (!prepared.ok) {
      return prepared;
    }
    let session: WinrmSession | undefined;
    try {
      session = await open(prepared.value);
      const result = await session.run({
        command: operation.command,
        stdin: operation.stdin,
        captureBytes: context.outputLimit.maxBytes + context.outputLimit.guardBytes,
      });
      return ok({
        result: { exit_code: result.exitCode, truncated: result.truncated },
        captured: { stdout: result.stdout, stderr: result.stderr },
      });
    } catch (error: unknown) {
      return fail(runFailure(error));
    } finally {
      if (session !== undefined) {
        await closeQuietly(session, context.logger);
      }
    }
  };
}
