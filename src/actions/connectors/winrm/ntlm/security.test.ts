import { describe, expect, it } from 'vitest';

import { FakeSecurity } from '../../../../test-support/fake-ntlm.ts';

import { NtlmProblem } from './reader.ts';
import { NtlmSecurity } from './security.ts';

/**
 * MS-NLMP 4.2.4.4, `GSS_WrapEx`: the random session key of 4.2.1, the
 * plaintext "Plaintext" in UTF-16LE, and the sealed bytes and 16-byte
 * signature the specification prints for them. The four sub-keys the example
 * derives on the way are asserted through that output rather than reached
 * into, because the output is what a Windows host checks.
 *
 * The other direction is driven by `FakeSecurity`, which implements the
 * destination's half independently, so a round trip proves the two halves
 * agree rather than that one function is its own inverse.
 */
const EXPORTED_SESSION_KEY = Buffer.alloc(16, 0x55);
const PLAINTEXT = Buffer.from('Plaintext', 'utf16le');
const SEALED = '54e50165bf1936dc996020c1811b0f06fb5f';
const SIGNATURE = '010000007fb38ec5c55d497600000000';

interface Pair {
  readonly client: NtlmSecurity;
  readonly destination: FakeSecurity;
}

function pair(isKeyExchange = true): Pair {
  return {
    client: new NtlmSecurity(EXPORTED_SESSION_KEY, isKeyExchange),
    destination: new FakeSecurity(EXPORTED_SESSION_KEY, isKeyExchange),
  };
}

describe('NTLM session security', () => {
  it('ACT-89 seals and signs exactly as the MS-NLMP 4.2.4.4 worked example does', () => {
    const { signature, sealed } = pair().client.seal(PLAINTEXT);
    expect(sealed.toString('hex')).toBe(SEALED);
    expect(signature.toString('hex')).toBe(SIGNATURE);
  });

  it('ACT-89 seals what the destination can read, and reads what the destination sealed', () => {
    const { client, destination } = pair();
    const outgoing = client.seal(Buffer.from('<s:Envelope/>', 'utf8'));
    expect(destination.fromClient(outgoing.signature, outgoing.sealed).toString('utf8')).toBe(
      '<s:Envelope/>',
    );
    const reply = destination.toClient(Buffer.from('<s:Body/>', 'utf8'));
    expect(client.unseal(reply.signature, reply.sealed).toString('utf8')).toBe('<s:Body/>');
  });

  it('ACT-89 counts each direction on its own across the messages of one shell', () => {
    const { client, destination } = pair();
    const sent: number[] = [];
    const received: string[] = [];
    for (const text of ['Create', 'Command', 'Receive', 'Delete']) {
      const outgoing = client.seal(Buffer.from(text, 'utf8'));
      sent.push(outgoing.signature.readUInt32LE(12));
      const reply = destination.toClient(
        Buffer.from(
          `${destination.fromClient(outgoing.signature, outgoing.sealed).toString('utf8')}Response`,
          'utf8',
        ),
      );
      received.push(client.unseal(reply.signature, reply.sealed).toString('utf8'));
    }
    expect(sent).toStrictEqual([0, 1, 2, 3]);
    expect(received).toStrictEqual([
      'CreateResponse',
      'CommandResponse',
      'ReceiveResponse',
      'DeleteResponse',
    ]);
  });

  it('ACT-89 refuses a reply that arrives out of sequence, never decoding it anyway', () => {
    const { client, destination } = pair();
    const first = destination.toClient(Buffer.from('first', 'utf8'));
    const second = destination.toClient(Buffer.from('second', 'utf8'));
    expect(() => client.unseal(second.signature, second.sealed)).toThrow(NtlmProblem);
    expect(first.signature.readUInt32LE(12)).toBe(0);
  });

  it('ACT-89 refuses a signature that was tampered with', () => {
    const { client, destination } = pair();
    const reply = destination.toClient(Buffer.from('payload', 'utf8'));
    const tampered = Buffer.from(reply.signature);
    tampered.writeUInt8(tampered.readUInt8(5) ^ 0xff, 5);
    expect(() => client.unseal(tampered, reply.sealed)).toThrow(
      'the message signature does not match what the destination sent',
    );
  });

  it('ACT-89 refuses a signature that is not sixteen bytes before it reads anything', () => {
    expect(() => pair().client.unseal(Buffer.alloc(8), Buffer.alloc(4))).toThrow(
      'the message signature is not sixteen bytes',
    );
  });

  it('ACT-89 leaves the checksum unencrypted when key exchange was not negotiated', () => {
    const { client, destination } = pair(false);
    const outgoing = client.seal(PLAINTEXT);
    expect(outgoing.sealed.toString('hex')).toBe(SEALED);
    expect(outgoing.signature.toString('hex')).not.toBe(SIGNATURE);
    expect(destination.fromClient(outgoing.signature, outgoing.sealed)).toStrictEqual(PLAINTEXT);
  });
});
