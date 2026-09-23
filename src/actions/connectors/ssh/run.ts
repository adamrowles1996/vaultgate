/**
 * One `ssh_run` on a server (§14.5): the credential read out of the injected
 * values (ACT-50), one connection opened to the pinned address with the host
 * name kept for the host-key lookup (ACT-55) and ended in `finally` (ACT-58),
 * one exec channel, and the two streams captured separately up to the output
 * limit plus the guard band (ACT-52). No pool and no session, so an idle
 * deployment holds no connections and a rotated key takes effect on the next
 * call.
 */
import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import { messageOf } from './failures.ts';

import type { SshOperation } from './operation.ts';
import type { SshCredential, SshDestination, SshPolicy } from './schemas.ts';
import type { SshAuth, SshConnection, SshSession, SshSessionFactory } from './session.ts';
import type { Logger } from '../../../logger.ts';
import type { InjectedValues } from '../../scrub.ts';
import type { ConnectorOutput, RunContext } from '../connector.ts';

export type SshRunContext = RunContext<SshDestination, SshCredential, SshPolicy>;

export type SshRun = (
  context: SshRunContext,
  operation: SshOperation,
) => Promise<Result<ConnectorOutput, ActionError>>;

function injected(values: InjectedValues, field: string): string | undefined {
  return values.value(field)?.toString('utf8');
}

/**
ACT-50, ACT-54: the mapped secrets, held only for the length of this call; any of them missing is the one code.
*/
function keyAuthOf(
  credential: Extract<SshCredential, { auth: 'key' }>,
  values: InjectedValues,
): SshAuth | undefined {
  const privateKey = injected(values, credential.key_field);
  const field = credential.passphrase_field;
  const passphrase = field === undefined ? undefined : injected(values, field);
  const isPassphraseMissing = field !== undefined && passphrase === undefined;
  return privateKey === undefined || isPassphraseMissing
    ? undefined
    : { kind: 'key', privateKey, passphrase };
}

function authOf(credential: SshCredential, values: InjectedValues): Result<SshAuth, ActionError> {
  const password =
    credential.auth === 'password' ? injected(values, credential.password_field) : undefined;
  const auth: SshAuth | undefined =
    credential.auth === 'password'
      ? password === undefined
        ? undefined
        : { kind: 'password', password }
      : keyAuthOf(credential, values);
  return auth === undefined ? fail(new ActionError('credential_unavailable')) : ok(auth);
}

function connectionOf(context: SshRunContext, address: string, auth: SshAuth): SshConnection {
  const { destination, policy } = context;
  return {
    host: destination.host,
    address,
    port: destination.port,
    username: destination.username,
    hostKey: destination.host_key,
    auth,
    connectTimeoutMs: policy.timeout_ms,
    signal: context.signal,
  };
}

/**
Everything the call needs before it connects; every refusal here happens with no connection open.
*/
function prepare(context: SshRunContext): Result<SshConnection, ActionError> {
  const [endpoint] = context.pinned;
  if (endpoint === undefined) {
    return fail(new ActionError('destination_refused', { reason: 'unpinned' }));
  }
  const auth = authOf(context.credential, context.injected);
  return auth.ok ? ok(connectionOf(context, endpoint.address, auth.value)) : auth;
}

/**
A connection that will not close is logged for the operator; it never changes the call's outcome.
*/
function closeQuietly(session: SshSession, logger: Logger): void {
  try {
    session.close();
  } catch (error) {
    logger.warn({ reason: messageOf(error) }, 'the ssh connection did not close cleanly');
  }
}

function failureOf(error: unknown): ActionError {
  return error instanceof ActionError
    ? error
    : new ActionError('upstream_error', { message: messageOf(error) });
}

/**
`run` of the `ssh` connector over an injected session factory (ACT-78).
*/
export function createRun(open: SshSessionFactory): SshRun {
  return async (context, operation) => {
    const prepared = prepare(context);
    if (!prepared.ok) {
      return prepared;
    }
    let session: SshSession | undefined;
    try {
      session = await open(prepared.value);
      const result = await session.exec({
        command: operation.command,
        stdin: operation.stdin,
        captureBytes: context.outputLimit.maxBytes + context.outputLimit.guardBytes,
      });
      return ok({
        result: { exit_code: result.exitCode, truncated: result.truncated },
        captured: { stdout: result.stdout, stderr: result.stderr },
      });
    } catch (error) {
      return fail(failureOf(error));
    } finally {
      if (session !== undefined) {
        closeQuietly(session, context.logger);
      }
    }
  };
}
