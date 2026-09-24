/**
 * The SOAP envelopes of the six WS-Management operations one `winrm_run`
 * needs (ACT-89, ACT-90): `Create` the shell, `Command`, `Send` the standard
 * input, `Receive` until the command state is `Done`, `Signal` it when the
 * policy timeout elapses, `Delete` the shell. They are written as text, not
 * built by an XML library: the documents are fixed, everything variable is
 * escaped here, and the only values that reach them are a command, a UUID
 * and base64.
 */
const SOAP = 'http://www.w3.org/2003/05/soap-envelope';
const ADDRESSING = 'http://schemas.xmlsoap.org/ws/2004/08/addressing';
const WSMAN = 'http://schemas.dmtf.org/wbem/wsman/1/wsman.xsd';
const SHELL = 'http://schemas.microsoft.com/wbem/wsman/1/windows/shell';
const TRANSFER = 'http://schemas.xmlsoap.org/ws/2004/09/transfer';

export const RESOURCE_URI = `${SHELL}/cmd`;
export const ANONYMOUS = `${ADDRESSING}/role/anonymous`;
export const COMMAND_DONE = `${SHELL}/CommandState/Done`;
export const TERMINATE = `${SHELL}/signal/terminate`;

export const ACTIONS = {
  create: `${TRANSFER}/Create`,
  command: `${SHELL}/Command`,
  send: `${SHELL}/Send`,
  receive: `${SHELL}/Receive`,
  signal: `${SHELL}/Signal`,
  delete: `${TRANSFER}/Delete`,
} as const;

/**
 * §13.11: the output cap is 1 MiB, so the shell is told to answer in
 * envelopes well under it and `Receive` is polled for the rest. The operation
 * timeout is the shell's own idle deadline; the policy timeout (ACT-59) is
 * shorter in every sane configuration and is what actually ends a call.
 */
const MAX_ENVELOPE_SIZE = 153_600;
const OPERATION_TIMEOUT = 'PT60S';
const LOCALE = 'en-US';

export type WinrmShell = 'powershell' | 'cmd';

export interface EnvelopeHeader {
  readonly action: string;
  /**
  The destination URL, as `wsa:To`; the socket still goes to the pinned address (ACT-55).
  */
  readonly url: string;
  readonly messageId: string;
  readonly shellId?: string | undefined;
  readonly options?: readonly (readonly [string, string])[] | undefined;
}

/**
 * The five characters XML reserves. Written as five passes rather than one
 * replacer, so there is no unreachable fallback to test.
 */
export function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function optionSet(options: readonly (readonly [string, string])[]): string {
  const entries = options
    .map(([name, value]) => `<w:Option Name="${escapeXml(name)}">${escapeXml(value)}</w:Option>`)
    .join('');
  return `<w:OptionSet>${entries}</w:OptionSet>`;
}

function selectorSet(shellId: string): string {
  return `<w:SelectorSet><w:Selector Name="ShellId">${escapeXml(shellId)}</w:Selector></w:SelectorSet>`;
}

function header(input: EnvelopeHeader): string {
  return [
    '<s:Header>',
    `<a:To>${escapeXml(input.url)}</a:To>`,
    `<w:ResourceURI s:mustUnderstand="true">${RESOURCE_URI}</w:ResourceURI>`,
    `<a:ReplyTo><a:Address s:mustUnderstand="true">${ANONYMOUS}</a:Address></a:ReplyTo>`,
    `<w:MaxEnvelopeSize s:mustUnderstand="true">${MAX_ENVELOPE_SIZE}</w:MaxEnvelopeSize>`,
    `<a:MessageID>uuid:${escapeXml(input.messageId)}</a:MessageID>`,
    `<w:Locale xml:lang="${LOCALE}" s:mustUnderstand="false"></w:Locale>`,
    `<w:OperationTimeout>${OPERATION_TIMEOUT}</w:OperationTimeout>`,
    `<a:Action s:mustUnderstand="true">${escapeXml(input.action)}</a:Action>`,
    input.shellId === undefined ? '' : selectorSet(input.shellId),
    input.options === undefined ? '' : optionSet(input.options),
    '</s:Header>',
  ].join('');
}

export function envelope(input: EnvelopeHeader, body: string): string {
  return [
    `<s:Envelope xmlns:s="${SOAP}" xmlns:a="${ADDRESSING}" xmlns:w="${WSMAN}" xmlns:rsp="${SHELL}">`,
    header(input),
    `<s:Body>${body}</s:Body>`,
    '</s:Envelope>',
  ].join('');
}

/**
 * ACT-90: one shell per call, with the caller's profile left alone and the
 * code page set to UTF-8 so what the command writes survives the round trip.
 */
export function createShell(url: string, messageId: string): string {
  return envelope(
    {
      action: ACTIONS.create,
      url,
      messageId,
      options: [
        ['WINRS_NOPROFILE', 'FALSE'],
        ['WINRS_CODEPAGE', '65001'],
      ],
    },
    '<rsp:Shell><rsp:InputStreams>stdin</rsp:InputStreams>' +
      '<rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell>',
  );
}

export interface CommandRequest {
  readonly url: string;
  readonly messageId: string;
  readonly shellId: string;
  readonly command: string;
  readonly shell: WinrmShell;
}

function commandLine(request: CommandRequest): string {
  if (request.shell === 'cmd') {
    return `<rsp:CommandLine><rsp:Command>${escapeXml(request.command)}</rsp:Command></rsp:CommandLine>`;
  }
  const encoded = Buffer.from(request.command, 'utf16le').toString('base64');
  const argumentNames = ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded];
  const encodedArguments = argumentNames
    .map((value) => `<rsp:Arguments>${escapeXml(value)}</rsp:Arguments>`)
    .join('');
  return `<rsp:CommandLine><rsp:Command>powershell</rsp:Command>${encodedArguments}</rsp:CommandLine>`;
}

/**
 * ACT-28: the `cmd` command line as the operator allowed it, or the
 * PowerShell command as `-EncodedCommand` over UTF-16LE base64, which no
 * shell re-parses. `WINRS_SKIP_CMD_SHELL` is `TRUE` for PowerShell, so the
 * arguments reach the process as written rather than through `cmd.exe`.
 */
export function runCommand(request: CommandRequest): string {
  return envelope(
    {
      action: ACTIONS.command,
      url: request.url,
      messageId: request.messageId,
      shellId: request.shellId,
      options: [
        ['WINRS_CONSOLEMODE_STDIN', 'TRUE'],
        ['WINRS_SKIP_CMD_SHELL', request.shell === 'cmd' ? 'FALSE' : 'TRUE'],
      ],
    },
    commandLine(request),
  );
}

export interface StreamRequest {
  readonly url: string;
  readonly messageId: string;
  readonly shellId: string;
  readonly commandId: string;
}

/**
ACT-27: the standard input, written once and closed with `End="true"`.
*/
export function sendStdin(request: StreamRequest, stdin: string): string {
  const encoded = Buffer.from(stdin, 'utf8').toString('base64');
  return envelope(
    {
      action: ACTIONS.send,
      url: request.url,
      messageId: request.messageId,
      shellId: request.shellId,
    },
    `<rsp:Send><rsp:Stream Name="stdin" CommandId="${escapeXml(request.commandId)}" End="true">${encoded}</rsp:Stream></rsp:Send>`,
  );
}

export function receive(request: StreamRequest): string {
  return envelope(
    {
      action: ACTIONS.receive,
      url: request.url,
      messageId: request.messageId,
      shellId: request.shellId,
    },
    `<rsp:Receive><rsp:DesiredStream CommandId="${escapeXml(request.commandId)}">stdout stderr</rsp:DesiredStream></rsp:Receive>`,
  );
}

/**
ACT-90: the command is terminated, not merely abandoned, when the call runs out of time.
*/
export function signalTerminate(request: StreamRequest): string {
  return envelope(
    {
      action: ACTIONS.signal,
      url: request.url,
      messageId: request.messageId,
      shellId: request.shellId,
    },
    `<rsp:Signal CommandId="${escapeXml(request.commandId)}"><rsp:Code>${TERMINATE}</rsp:Code></rsp:Signal>`,
  );
}

export function deleteShell(url: string, messageId: string, shellId: string): string {
  return envelope({ action: ACTIONS.delete, url, messageId, shellId }, '');
}
