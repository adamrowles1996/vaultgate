/**
 * What the connector reads out of a WS-Management answer (ACT-90): the shell
 * and command identifiers, the base64 output streams, the command state with
 * its exit code, and a SOAP fault with the subcode that says whether the
 * shell merely had nothing to say yet. Everything here goes through the
 * strict reader of `./xml.ts`, and a value that is not the shape the protocol
 * promises is a malformed response, never a guess.
 */
import { COMMAND_DONE } from './envelopes.ts';
import { at, descendants, XmlProblem, type XmlElement } from './xml.ts';

const BASE64 = /^[\d+/A-Za-z]*={0,2}$/u;
const WHITESPACE = /\s+/gu;
const DECIMAL = /^-?\d{1,10}$/u;

export interface SoapFault {
  /**
  The local part of the fault subcode (`TimedOut`, `InvalidSelectors`), or the empty string.
  */
  readonly subcode: string;
  readonly reason: string;
}

/**
MS-WSMV: a `Receive` that waited out the operation timeout with nothing to send answers with this.
*/
export const TIMED_OUT = 'TimedOut';

function localPart(text: string): string {
  const colon = text.indexOf(':');
  return colon === -1 ? text : text.slice(colon + 1);
}

/**
 * The fault a response carries, or `undefined` when it carries none. The
 * reason is the SOAP `Reason`, falling back to the `WSManFault` message
 * Windows puts in the detail, and the caller caps and scrubs it (ACT-74).
 */
export function faultOf(envelope: XmlElement): SoapFault | undefined {
  const fault = at(envelope, 'Body', 'Fault');
  if (fault === undefined) {
    return undefined;
  }
  const subcode = at(fault, 'Code', 'Subcode', 'Value')?.text ?? '';
  const reason = at(fault, 'Reason', 'Text')?.text ?? '';
  const detail = descendants(fault, 'Message')[0]?.text ?? '';
  return { subcode: localPart(subcode), reason: reason === '' ? detail : reason };
}

export function shellIdOf(envelope: XmlElement): string {
  return required(descendants(envelope, 'ShellId')[0]?.text, 'a shell identifier');
}

export function commandIdOf(envelope: XmlElement): string {
  return required(
    at(envelope, 'Body', 'CommandResponse', 'CommandId')?.text,
    'a command identifier',
  );
}

function required(value: string | undefined, what: string): string {
  if (value === undefined || value === '') {
    throw new XmlProblem(`the response does not carry ${what}`);
  }
  return value;
}

export interface ReceivedStream {
  readonly name: string;
  readonly bytes: Buffer;
}

export interface Received {
  readonly streams: readonly ReceivedStream[];
  /**
  ACT-27: the exit status once the command is done, `undefined` while it is still running.
  */
  readonly exitCode: number | undefined;
  readonly isDone: boolean;
}

function decodeStream(element: XmlElement): Buffer {
  const encoded = element.text.replaceAll(WHITESPACE, '');
  if (!BASE64.test(encoded)) {
    throw new XmlProblem('an output stream is not base64');
  }
  return Buffer.from(encoded, 'base64');
}

function exitCodeOf(state: XmlElement | undefined): number | undefined {
  const text = state === undefined ? undefined : at(state, 'ExitCode')?.text;
  if (text === undefined) {
    return undefined;
  }
  if (!DECIMAL.test(text)) {
    throw new XmlProblem('the exit code is not a number');
  }
  return Number(text);
}

/**
 * One `Receive` answer: whatever the two streams carried this time, and
 * whether the command has finished (ACT-90).
 */
export function receivedOf(envelope: XmlElement): Received {
  const streams = descendants(envelope, 'Stream').map((element) => ({
    name: element.attributes['Name'] ?? '',
    bytes: decodeStream(element),
  }));
  const state = descendants(envelope, 'CommandState')[0];
  return {
    streams,
    exitCode: exitCodeOf(state),
    isDone: state?.attributes['State'] === COMMAND_DONE,
  };
}
