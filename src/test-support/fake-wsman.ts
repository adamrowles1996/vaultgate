/**
 * A fake WS-Management destination for the `winrm` contract tests (ACT-75): a
 * pinned transport that reads each request's `wsa:Action` with the
 * connector's own strict reader — so an envelope the connector builds but
 * could not read back is a test failure — records every request, and answers
 * the six operations from a script. A `handler` overrides any of them, which
 * is how a fault, a 401, a malformed body or a request that never answers is
 * driven. No test needs a Windows host.
 */
import { at, parseXml } from '../actions/connectors/winrm/xml.ts';

import type { PinnedFetch, PinnedRequest } from '../net/pinned-https.ts';

export type WsmanReply = Response | Error | 'hang';

/**
Answers an operation instead of the script; `undefined` lets the script answer.
*/
export type WsmanHandler = (
  action: string,
  request: PinnedRequest,
  index: number,
) => WsmanReply | undefined;

export interface ReceiveScript {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly done?: boolean;
  readonly exitCode?: number;
  /**
  MS-WSMV: the shell waited out its operation timeout with nothing to send.
  */
  readonly timedOut?: boolean;
}

export interface FakeWsmanOptions {
  readonly shellId?: string;
  readonly commandId?: string;
  /**
  What each `Receive` answers, in order; the last answer repeats.
  */
  readonly receives?: readonly ReceiveScript[];
  readonly handler?: WsmanHandler;
}

export interface FakeWsman {
  readonly transport: PinnedFetch;
  readonly requests: PinnedRequest[];
  /**
  The local name of each request's `wsa:Action` (`Create`, `Command`, `Send`, `Receive`, `Signal`, `Delete`).
  */
  readonly actions: string[];
  /**
  Every request body, as the destination saw it.
  */
  readonly bodies: string[];
}

export const SHELL_ID = '11111111-2222-3333-4444-555555555555';
export const COMMAND_ID = '66666666-7777-8888-9999-000000000000';

const SOAP_HEADERS = { 'content-type': 'application/soap+xml;charset=UTF-8' } as const;

function envelope(body: string): string {
  return (
    '<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" ' +
    'xmlns:rsp="http://schemas.microsoft.com/wbem/wsman/1/windows/shell">' +
    `<s:Header></s:Header><s:Body>${body}</s:Body></s:Envelope>`
  );
}

export function soapResponse(body: string, status = 200): Response {
  return new Response(envelope(body), { status, headers: SOAP_HEADERS });
}

/**
A SOAP fault as WinRM sends one: HTTP 500 with the subcode and reason.
*/
export function soapFault(subcode: string, reason: string, status = 500): Response {
  return soapResponse(
    `<s:Fault><s:Code><s:Value>s:Receiver</s:Value>` +
      `<s:Subcode><s:Value>w:${subcode}</s:Value></s:Subcode></s:Code>` +
      `<s:Reason><s:Text xml:lang="en-US">${reason}</s:Text></s:Reason></s:Fault>`,
    status,
  );
}

function stream(name: string, text: string): string {
  return `<rsp:Stream Name="${name}" CommandId="${COMMAND_ID}">${Buffer.from(text, 'utf8').toString('base64')}</rsp:Stream>`;
}

function receiveBody(script: ReceiveScript): string {
  const streams = [
    ...(script.stdout === undefined ? [] : [stream('stdout', script.stdout)]),
    ...(script.stderr === undefined ? [] : [stream('stderr', script.stderr)]),
  ].join('');
  const state =
    script.done === true
      ? '<rsp:CommandState State="http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done">' +
        `<rsp:ExitCode>${script.exitCode ?? 0}</rsp:ExitCode></rsp:CommandState>`
      : '<rsp:CommandState State="http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Running"></rsp:CommandState>';
  return `<rsp:ReceiveResponse>${streams}${state}</rsp:ReceiveResponse>`;
}

function localAction(body: string): string {
  const action = at(parseXml(body), 'Header', 'Action')?.text ?? '';
  return action.slice(action.lastIndexOf('/') + 1);
}

const DEFAULT_RECEIVES: readonly ReceiveScript[] = [{ stdout: '', done: true, exitCode: 0 }];

function scriptedReceive(options: FakeWsmanOptions, index: number): WsmanReply {
  const scripts = options.receives ?? DEFAULT_RECEIVES;
  const script = scripts.at(Math.min(index, scripts.length - 1)) ?? DEFAULT_RECEIVES[0];
  return script === undefined || script.timedOut === true
    ? soapFault('TimedOut', 'The WS-Management service cannot complete the operation.')
    : soapResponse(receiveBody(script));
}

function scripted(options: FakeWsmanOptions, action: string, receives: number): WsmanReply {
  const shellId = options.shellId ?? SHELL_ID;
  switch (action) {
    case 'Create': {
      return soapResponse(`<rsp:Shell><rsp:ShellId>${shellId}</rsp:ShellId></rsp:Shell>`);
    }
    case 'Command': {
      return soapResponse(
        `<rsp:CommandResponse><rsp:CommandId>${options.commandId ?? COMMAND_ID}</rsp:CommandId></rsp:CommandResponse>`,
      );
    }
    case 'Receive': {
      return scriptedReceive(options, receives);
    }
    default: {
      return soapResponse('');
    }
  }
}

function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const stop = (): void => {
      reject(signal.reason as Error);
    };
    if (signal.aborted) {
      stop();
      return;
    }
    signal.addEventListener('abort', stop, { once: true });
  });
}

export function fakeWsman(options: FakeWsmanOptions = {}): FakeWsman {
  const requests: PinnedRequest[] = [];
  const actions: string[] = [];
  const bodies: string[] = [];
  const transport: PinnedFetch = (request) => {
    const body = request.body?.toString('utf8') ?? '';
    const action = localAction(body);
    requests.push(request);
    actions.push(action);
    bodies.push(body);
    const receives = actions.filter((name) => name === 'Receive').length - 1;
    const reply =
      options.handler?.(action, request, requests.length - 1) ??
      scripted(options, action, receives);
    if (reply === 'hang') {
      return untilAborted(request.signal);
    }
    return reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply);
  };
  return { transport, requests, actions, bodies };
}
