import { describe, expect, it } from 'vitest';

import { FakeSecurity } from '../../../test-support/fake-ntlm.ts';

import {
  ENCRYPTED_CONTENT_TYPE,
  isEncrypted,
  unwrapEncrypted,
  wrapEncrypted,
} from './encryption.ts';
import { NtlmProblem } from './ntlm/reader.ts';
import { NtlmSecurity } from './ntlm/security.ts';

const KEY = Buffer.alloc(16, 0x55);
const ENVELOPE = '<s:Envelope><s:Body>run</s:Body></s:Envelope>';

interface Pair {
  readonly client: NtlmSecurity;
  readonly destination: FakeSecurity;
}

function pair(): Pair {
  return { client: new NtlmSecurity(KEY, true), destination: new FakeSecurity(KEY, true) };
}

/**
The destination's reply, wrapped the way MS-WSMV 2.2.9.1 wraps one.
*/
function replyFrom(destination: FakeSecurity, soap: string): Buffer {
  const plain = Buffer.from(soap, 'utf8');
  const { signature, sealed } = destination.toClient(plain);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signature.length, 0);
  const head = [
    '--Encrypted Boundary',
    '\tContent-Type: application/HTTP-SPNEGO-session-encrypted',
    `\tOriginalContent: type=application/soap+xml;charset=UTF-8;Length=${plain.length}`,
    '--Encrypted Boundary',
    '\tContent-Type: application/octet-stream',
    '',
  ].join('\r\n');
  return Buffer.concat([
    Buffer.from(head, 'ascii'),
    length,
    signature,
    sealed,
    Buffer.from('--Encrypted Boundary--\r\n', 'ascii'),
  ]);
}

describe('MS-WSMV message encryption', () => {
  it('ACT-89 wraps an envelope into the form the destination expects, and it reads back', () => {
    const { client, destination } = pair();
    const wrapped = wrapEncrypted(client, ENVELOPE);
    const text = wrapped.toString('latin1');
    expect(text.startsWith('--Encrypted Boundary\r\n')).toBe(true);
    expect(text).toContain('\tContent-Type: application/HTTP-SPNEGO-session-encrypted\r\n');
    expect(text).toContain(
      `\tOriginalContent: type=application/soap+xml;charset=UTF-8;Length=${ENVELOPE.length}\r\n`,
    );
    expect(text).toContain('\tContent-Type: application/octet-stream\r\n');
    expect(text.endsWith('--Encrypted Boundary--\r\n')).toBe(true);
    const at = text.indexOf('application/octet-stream\r\n') + 'application/octet-stream\r\n'.length;
    expect(wrapped.readUInt32LE(at)).toBe(16);
    const signature = wrapped.subarray(at + 4, at + 20);
    const sealed = wrapped.subarray(at + 20, at + 20 + ENVELOPE.length);
    expect(destination.fromClient(signature, sealed).toString('utf8')).toBe(ENVELOPE);
  });

  it('ACT-89 unwraps the destination reply and verifies it, with or without the closing newline', () => {
    const first = pair();
    expect(unwrapEncrypted(first.client, replyFrom(first.destination, '<ok/>'))).toBe('<ok/>');
    const second = pair();
    const body = replyFrom(second.destination, '<ok/>');
    expect(unwrapEncrypted(second.client, body.subarray(0, -2))).toBe('<ok/>');
  });

  it('T33 refuses a reply whose signature was tampered with', () => {
    const { client, destination } = pair();
    const body = replyFrom(destination, '<ok/>');
    const at = body.toString('latin1').indexOf('application/octet-stream\r\n') + 26 + 4;
    body.writeUInt8(body.readUInt8(at) ^ 0xff, at);
    expect(() => unwrapEncrypted(client, body)).toThrow(
      'the message signature does not match what the destination sent',
    );
  });

  it('T33 refuses every shape that is not the envelope MS-WSMV defines', () => {
    const good = replyFrom(pair().destination, '<ok/>').toString('latin1');
    const refusals = [
      '',
      'not multipart at all\r\n',
      good.replace('application/HTTP-SPNEGO-session-encrypted', 'text/plain'),
      good.replace(/OriginalContent:[^\r]*/u, 'OriginalContent: who knows'),
      good.replace('\tContent-Type: application/octet-stream', '\tContent-Type: text/plain'),
      good.replace(/--Encrypted Boundary--\r\n$/u, 'trailing rubbish'),
      good.replace(/Length=\d+/u, 'Length=999999'),
    ];
    for (const refused of refusals) {
      expect(() =>
        unwrapEncrypted(new NtlmSecurity(KEY, true), Buffer.from(refused, 'latin1')),
      ).toThrow(NtlmProblem);
    }
  });

  it('T33 refuses a header line that never ends, however long the destination makes it', () => {
    const endless = Buffer.from(`--Encrypted Boundary\r\n${'x'.repeat(2000)}`, 'ascii');
    expect(() => unwrapEncrypted(new NtlmSecurity(KEY, true), endless)).toThrow(
      'a header line of the encrypted body does not end',
    );
  });

  it('T33 refuses a signature length that points past the body', () => {
    const destination = pair().destination;
    const body = replyFrom(destination, '<ok/>');
    const at = body.toString('latin1').indexOf('application/octet-stream\r\n') + 26;
    body.writeUInt32LE(0xff_ff_ff, at);
    expect(() => unwrapEncrypted(new NtlmSecurity(KEY, true), body)).toThrow(NtlmProblem);
  });

  it('ACT-89 names the protocol in the content type and recognises it coming back', () => {
    expect(ENCRYPTED_CONTENT_TYPE).toBe(
      'multipart/encrypted;protocol="application/HTTP-SPNEGO-session-encrypted";boundary="Encrypted Boundary"',
    );
    expect(isEncrypted(ENCRYPTED_CONTENT_TYPE)).toBe(true);
    expect(isEncrypted('application/soap+xml;charset=UTF-8')).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });
});
