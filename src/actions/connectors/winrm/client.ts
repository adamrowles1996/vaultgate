/**
 * The WS-Management client (ACT-89, ACT-90): the six SOAP exchanges of one
 * `winrm_run`, each a single POST through the pinned transport to the address
 * the engine validated, with the URL's host name kept for TLS and `wsa:To`
 * (ACT-55) and the leaf certificate judged against the target's pin where it
 * has one (ACT-57). How each envelope is authenticated and whether it is
 * encrypted belongs to `./transport.ts`: `negotiate` runs NTLM and seals the
 * payload, `basic` sends the pair over TLS. The shell is created per call and
 * deleted when the call ends; a command that outlives the policy timeout is
 * terminated first, on a deadline of its own, because the call's has already
 * elapsed.
 */
import { pinnedCertificateCheck, type CertificateCheck } from '../../../net/certificate-pin.ts';
import { ActionError } from '../../errors.ts';
import { Capture } from '../capture.ts';

import {
  createShell,
  deleteShell,
  receive,
  runCommand,
  sendStdin,
  signalTerminate,
  type StreamRequest,
} from './envelopes.ts';
import {
  faultFailure,
  OK,
  statusFailure,
  transportFailure,
  unreadableResponse,
} from './failures.ts';
import {
  commandIdOf,
  faultOf,
  receivedOf,
  shellIdOf,
  TIMED_OUT,
  type Received,
} from './responses.ts';
import { openTransport, type SoapAnswer, type WinrmTransport } from './transport.ts';
import { parseXml, XmlProblem, type XmlElement } from './xml.ts';

import type {
  WinrmCommand,
  WinrmConnection,
  WinrmDependencies,
  WinrmResult,
  WinrmSession,
  WinrmSessionFactory,
} from './session.ts';

interface Wire {
  readonly dependencies: WinrmDependencies;
  readonly connection: WinrmConnection;
  readonly transport: WinrmTransport;
}

interface Answer {
  readonly envelope: XmlElement;
  readonly status: number;
}

/**
ACT-57: the pin replaces the system store where the target names one.
*/
function certificateFor(connection: WinrmConnection): CertificateCheck | undefined {
  return connection.certificateSha256 === undefined
    ? undefined
    : pinnedCertificateCheck(connection.certificateSha256);
}

/**
 * A reader of the strict parser's result: what the reader refuses is a
 * malformed response (T33), and anything else is a fault of vaultgate's own
 * and is left to travel as itself.
 */
export function read<Value>(reader: () => Value): Value {
  try {
    return reader();
  } catch (error) {
    if (error instanceof XmlProblem) {
      throw unreadableResponse();
    }
    throw error;
  }
}

async function post(wire: Wire, body: string, signal: AbortSignal): Promise<Answer> {
  let answer: SoapAnswer;
  try {
    answer = await wire.transport.send(body, signal);
  } catch (error: unknown) {
    throw transportFailure(error, signal);
  }
  return { envelope: read(() => parseXml(answer.text)), status: answer.status };
}

/**
One exchange that has to succeed: a fault or a status other than 200 ends the call.
*/
async function call(wire: Wire, body: string, signal: AbortSignal): Promise<XmlElement> {
  const answer = await post(wire, body, signal);
  const fault = faultOf(answer.envelope);
  if (fault !== undefined) {
    throw faultFailure(fault);
  }
  if (answer.status !== OK) {
    throw statusFailure(answer.status);
  }
  return answer.envelope;
}

function streamPlan(wire: Wire, shellId: string, commandId: string): StreamRequest {
  return {
    url: wire.connection.url,
    messageId: wire.dependencies.newId(),
    shellId,
    commandId,
  };
}

/**
 * One `Receive`. `undefined` means the shell waited out its operation timeout
 * with nothing to send, which MS-WSMV reports as a `TimedOut` fault and which
 * only means "ask again".
 */
async function receiveOnce(wire: Wire, plan: StreamRequest): Promise<Received | undefined> {
  const answer = await post(wire, receive(plan), wire.connection.signal);
  const fault = faultOf(answer.envelope);
  if (fault !== undefined) {
    if (fault.subcode === TIMED_OUT) {
      return undefined;
    }
    throw faultFailure(fault);
  }
  if (answer.status !== OK) {
    throw statusFailure(answer.status);
  }
  return read(() => receivedOf(answer.envelope));
}

function resultOf(received: Received, stdout: Capture, stderr: Capture): WinrmResult {
  return {
    exitCode: received.exitCode ?? null,
    stdout: stdout.bytes,
    stderr: stderr.bytes,
    truncated: stdout.isTruncated || stderr.isTruncated,
  };
}

/**
ACT-90: polled until the command state is `Done`, or until the policy timeout ends the call (ACT-59).
*/
async function collect(
  wire: Wire,
  plan: () => StreamRequest,
  captureBytes: number,
): Promise<WinrmResult> {
  const stdout = new Capture(captureBytes);
  const stderr = new Capture(captureBytes);
  for (;;) {
    if (wire.connection.signal.aborted) {
      throw new ActionError('timeout');
    }
    const received = await receiveOnce(wire, plan());
    if (received === undefined) {
      continue;
    }
    for (const stream of received.streams) {
      (stream.name === 'stderr' ? stderr : stdout).add(stream.bytes);
    }
    if (received.isDone) {
      return resultOf(received, stdout, stderr);
    }
  }
}

/**
ACT-90: the command is terminated before the shell is deleted; a failure here never changes the outcome.
*/
async function terminate(wire: Wire, plan: StreamRequest): Promise<void> {
  try {
    await call(wire, signalTerminate(plan), wire.dependencies.cleanupSignal());
  } catch {
    // The call has already failed; `Delete` still follows and ends the shell.
  }
}

function session(wire: Wire, shellId: string): WinrmSession {
  const { url } = wire.connection;
  return {
    async run(request: WinrmCommand): Promise<WinrmResult> {
      const started = await call(
        wire,
        runCommand({
          url,
          messageId: wire.dependencies.newId(),
          shellId,
          command: request.command,
          shell: wire.connection.shell,
        }),
        wire.connection.signal,
      );
      const commandId = read(() => commandIdOf(started));
      if (request.stdin !== undefined) {
        const plan = streamPlan(wire, shellId, commandId);
        await call(wire, sendStdin(plan, request.stdin), wire.connection.signal);
      }
      try {
        return await collect(
          wire,
          () => streamPlan(wire, shellId, commandId),
          request.captureBytes,
        );
      } catch (error: unknown) {
        await terminate(wire, streamPlan(wire, shellId, commandId));
        throw error;
      }
    },
    async close(): Promise<void> {
      try {
        await call(
          wire,
          deleteShell(url, wire.dependencies.newId(), shellId),
          wire.dependencies.cleanupSignal(),
        );
      } finally {
        // NTLM authenticates the connection, so the session's socket ends here.
        wire.transport.release();
      }
    },
  };
}

/**
ACT-58: the shell is created after the policy decision and holds for this call only.
*/
export function winrmSessionOver(dependencies: WinrmDependencies): WinrmSessionFactory {
  return async (connection) => {
    const wire: Wire = {
      dependencies,
      connection,
      transport: openTransport(connection, dependencies, certificateFor(connection)),
    };
    try {
      const created = await call(
        wire,
        createShell(connection.url, dependencies.newId()),
        connection.signal,
      );
      return session(
        wire,
        read(() => shellIdOf(created)),
      );
    } catch (error: unknown) {
      wire.transport.release();
      throw error;
    }
  };
}
