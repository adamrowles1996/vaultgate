import { describe, expect, it } from 'vitest';

import { soapFault, soapResponse } from '../../../test-support/fake-wsman.ts';

import { COMMAND_DONE } from './envelopes.ts';
import { commandIdOf, faultOf, receivedOf, shellIdOf, TIMED_OUT } from './responses.ts';
import { parseXml, XmlProblem, type XmlElement } from './xml.ts';

async function envelopeOf(response: Response): Promise<XmlElement> {
  return parseXml(await response.text());
}

function wrap(body: string): XmlElement {
  return parseXml(
    `<s:Envelope xmlns:s="urn:soap" xmlns:rsp="urn:shell"><s:Body>${body}</s:Body></s:Envelope>`,
  );
}

function refusesReceive(body: string): string {
  return refuses(() => receivedOf(wrap(body)));
}

function refuses(read: () => unknown): string {
  try {
    read();
  } catch (error: unknown) {
    return error instanceof XmlProblem ? error.message : 'not an XmlProblem';
  }
  return 'accepted';
}

describe('faultOf', () => {
  it('ACT-90 reads the subcode and reason of a fault, and answers undefined without one', async () => {
    const fault = faultOf(await envelopeOf(soapFault(TIMED_OUT, 'nothing to send yet')));
    expect(fault).toStrictEqual({ subcode: TIMED_OUT, reason: 'nothing to send yet' });
    const shell = await envelopeOf(soapResponse('<rsp:Shell></rsp:Shell>'));
    expect(faultOf(shell)).toBeUndefined();
  });

  it('ACT-74 falls back to the WSManFault message when the fault carries no reason', () => {
    const envelope = wrap(
      '<s:Fault><s:Code><s:Value>s:Sender</s:Value></s:Code>' +
        '<s:Detail><f:WSManFault><f:Message>Access is denied.</f:Message></f:WSManFault></s:Detail>' +
        '</s:Fault>',
    );
    expect(faultOf(envelope)).toStrictEqual({ subcode: '', reason: 'Access is denied.' });
  });

  it('ACT-74 answers an empty reason when the fault carries neither', () => {
    expect(faultOf(wrap('<s:Fault></s:Fault>'))).toStrictEqual({ subcode: '', reason: '' });
  });
});

describe('shellIdOf and commandIdOf', () => {
  it('ACT-90 read the identifiers the shell and command responses carry', () => {
    expect(shellIdOf(wrap('<rsp:Shell><rsp:ShellId>abc</rsp:ShellId></rsp:Shell>'))).toBe('abc');
    expect(
      commandIdOf(
        wrap('<rsp:CommandResponse><rsp:CommandId>xyz</rsp:CommandId></rsp:CommandResponse>'),
      ),
    ).toBe('xyz');
  });

  it('T33 refuse a response that carries neither', () => {
    expect(refuses(() => shellIdOf(wrap('<rsp:Shell></rsp:Shell>')))).toContain(
      'does not carry a shell identifier',
    );
    expect(
      refuses(() => commandIdOf(wrap('<rsp:CommandResponse></rsp:CommandResponse>'))),
    ).toContain('does not carry a command identifier');
  });
});

describe('receivedOf', () => {
  it('ACT-90 decodes both streams and reports the command as still running', () => {
    const received = receivedOf(
      wrap(
        '<rsp:ReceiveResponse>' +
          `<rsp:Stream Name="stdout">${Buffer.from('out', 'utf8').toString('base64')}</rsp:Stream>` +
          `<rsp:Stream Name="stderr">${Buffer.from('err', 'utf8').toString('base64')}</rsp:Stream>` +
          '<rsp:CommandState State="urn:Running"></rsp:CommandState></rsp:ReceiveResponse>',
      ),
    );
    expect(received.isDone).toBe(false);
    expect(received.exitCode).toBeUndefined();
    expect(
      received.streams.map((stream) => [stream.name, stream.bytes.toString('utf8')]),
    ).toStrictEqual([
      ['stdout', 'out'],
      ['stderr', 'err'],
    ]);
  });

  it('ACT-27 reports the exit code once the command state is Done', () => {
    const received = receivedOf(
      wrap(
        `<rsp:ReceiveResponse><rsp:CommandState State="${COMMAND_DONE}">` +
          '<rsp:ExitCode>1</rsp:ExitCode></rsp:CommandState></rsp:ReceiveResponse>',
      ),
    );
    expect(received).toStrictEqual({ streams: [], exitCode: 1, isDone: true });
  });

  it('ACT-90 answers nothing at all for a response with no streams and no state', () => {
    expect(receivedOf(wrap('<rsp:ReceiveResponse></rsp:ReceiveResponse>'))).toStrictEqual({
      streams: [],
      exitCode: undefined,
      isDone: false,
    });
  });

  it('T33 refuses a stream that is not base64 and an exit code that is not a number', () => {
    expect(
      refusesReceive(
        '<rsp:ReceiveResponse><rsp:Stream Name="stdout">not base64!</rsp:Stream></rsp:ReceiveResponse>',
      ),
    ).toContain('not base64');
    expect(
      refusesReceive(
        `<rsp:ReceiveResponse><rsp:CommandState State="${COMMAND_DONE}">` +
          '<rsp:ExitCode>nine</rsp:ExitCode></rsp:CommandState></rsp:ReceiveResponse>',
      ),
    ).toContain('not a number');
  });

  it('ACT-90 accepts base64 broken over lines, as a destination may send it', () => {
    const encoded = Buffer.from('wrapped', 'utf8').toString('base64');
    const received = receivedOf(
      wrap(
        `<rsp:ReceiveResponse><rsp:Stream Name="stdout">${encoded.slice(0, 4)}\n  ${encoded.slice(4)}</rsp:Stream></rsp:ReceiveResponse>`,
      ),
    );
    expect(received.streams[0]?.bytes.toString('utf8')).toBe('wrapped');
  });

  it('ACT-90 names a stream that carries no name at all as the empty string', () => {
    const received = receivedOf(
      wrap('<rsp:ReceiveResponse><rsp:Stream></rsp:Stream></rsp:ReceiveResponse>'),
    );
    expect(received.streams).toStrictEqual([{ name: '', bytes: Buffer.alloc(0) }]);
  });
});
