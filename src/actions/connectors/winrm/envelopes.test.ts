import { describe, expect, it } from 'vitest';

import {
  ACTIONS,
  COMMAND_DONE,
  createShell,
  deleteShell,
  escapeXml,
  receive,
  RESOURCE_URI,
  runCommand,
  sendStdin,
  signalTerminate,
  TERMINATE,
  type StreamRequest,
} from './envelopes.ts';
import { at, parseXml } from './xml.ts';

const URL = 'https://win.example.com:5986/wsman';
const SHELL_ID = 'shell-1';
const PLAN: StreamRequest = {
  url: URL,
  messageId: 'message-1',
  shellId: SHELL_ID,
  commandId: 'command-1',
};

function actionOf(body: string): string | undefined {
  return at(parseXml(body), 'Header', 'Action')?.text;
}

describe('the WS-Management envelopes', () => {
  it('ACT-89 every envelope this connector builds is readable by its own strict reader', () => {
    const built = [
      createShell(URL, 'message-1'),
      runCommand({ ...PLAN, command: 'Get-ComputerInfo', shell: 'powershell' }),
      sendStdin(PLAN, 'hello'),
      receive(PLAN),
      signalTerminate(PLAN),
      deleteShell(URL, 'message-1', SHELL_ID),
    ];
    expect(built.map((body) => actionOf(body))).toStrictEqual([
      ACTIONS.create,
      ACTIONS.command,
      ACTIONS.send,
      ACTIONS.receive,
      ACTIONS.signal,
      ACTIONS.delete,
    ]);
  });

  it('ACT-90 creates one shell with both output streams, no profile and code page 65001', () => {
    const body = createShell(URL, 'message-1');
    expect(body).toContain(`<a:To>${URL}</a:To>`);
    expect(body).toContain(
      `<w:ResourceURI s:mustUnderstand="true">${RESOURCE_URI}</w:ResourceURI>`,
    );
    expect(body).toContain('<a:MessageID>uuid:message-1</a:MessageID>');
    expect(body).toContain('<w:MaxEnvelopeSize s:mustUnderstand="true">153600</w:MaxEnvelopeSize>');
    expect(body).toContain('<w:OperationTimeout>PT60S</w:OperationTimeout>');
    expect(body).toContain('<w:Option Name="WINRS_NOPROFILE">FALSE</w:Option>');
    expect(body).toContain('<w:Option Name="WINRS_CODEPAGE">65001</w:Option>');
    expect(body).toContain(
      '<s:Body><rsp:Shell><rsp:InputStreams>stdin</rsp:InputStreams>' +
        '<rsp:OutputStreams>stdout stderr</rsp:OutputStreams></rsp:Shell></s:Body>',
    );
    expect(body).not.toContain('SelectorSet');
  });

  it('ACT-28 sends a PowerShell command as an encoded command that no shell re-parses', () => {
    const body = runCommand({ ...PLAN, command: 'Get-Service "spooler"', shell: 'powershell' });
    const encoded = Buffer.from('Get-Service "spooler"', 'utf16le').toString('base64');
    expect(body).toContain(
      '<s:Body><rsp:CommandLine><rsp:Command>powershell</rsp:Command>' +
        '<rsp:Arguments>-NoProfile</rsp:Arguments>' +
        '<rsp:Arguments>-NonInteractive</rsp:Arguments>' +
        '<rsp:Arguments>-EncodedCommand</rsp:Arguments>' +
        `<rsp:Arguments>${encoded}</rsp:Arguments></rsp:CommandLine></s:Body>`,
    );
    expect(body).toContain('<w:Option Name="WINRS_SKIP_CMD_SHELL">TRUE</w:Option>');
    expect(body).toContain(
      `<w:SelectorSet><w:Selector Name="ShellId">${SHELL_ID}</w:Selector></w:SelectorSet>`,
    );
    expect(body).not.toContain('spooler');
  });

  it('ACT-28 sends a cmd command as the command line, escaped, through cmd.exe', () => {
    const body = runCommand({ ...PLAN, command: 'echo "a" & b <c>', shell: 'cmd' });
    expect(body).toContain(
      '<s:Body><rsp:CommandLine><rsp:Command>echo &quot;a&quot; &amp; b &lt;c&gt;</rsp:Command>' +
        '</rsp:CommandLine></s:Body>',
    );
    expect(body).toContain('<w:Option Name="WINRS_SKIP_CMD_SHELL">FALSE</w:Option>');
    expect(body).toContain('<w:Option Name="WINRS_CONSOLEMODE_STDIN">TRUE</w:Option>');
  });

  it('ACT-27 writes the standard input as one base64 stream and closes it', () => {
    const body = sendStdin(PLAN, 'line\n');
    expect(body).toContain(
      '<s:Body><rsp:Send><rsp:Stream Name="stdin" CommandId="command-1" End="true">' +
        `${Buffer.from('line\n', 'utf8').toString('base64')}</rsp:Stream></rsp:Send></s:Body>`,
    );
  });

  it('ACT-90 asks for both streams of the command and terminates exactly that command', () => {
    expect(receive(PLAN)).toContain(
      '<s:Body><rsp:Receive><rsp:DesiredStream CommandId="command-1">stdout stderr' +
        '</rsp:DesiredStream></rsp:Receive></s:Body>',
    );
    expect(signalTerminate(PLAN)).toContain(
      `<s:Body><rsp:Signal CommandId="command-1"><rsp:Code>${TERMINATE}</rsp:Code></rsp:Signal></s:Body>`,
    );
    expect(deleteShell(URL, 'message-1', SHELL_ID)).toContain('<s:Body></s:Body>');
  });

  it('ACT-89 the command state the connector polls for is the MS-WSMV one', () => {
    expect(COMMAND_DONE).toBe(
      'http://schemas.microsoft.com/wbem/wsman/1/windows/shell/CommandState/Done',
    );
  });
});

describe('escapeXml', () => {
  it('T33 escapes every character XML reserves, once', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
    expect(escapeXml('plain')).toBe('plain');
  });
});
