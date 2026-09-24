import { describe, expect, it } from 'vitest';

import { FakeNtlm } from '../../../../test-support/fake-ntlm.ts';

import { authenticateMessage } from './authenticate.ts';
import { AV_CHANNEL_BINDINGS, parseChallenge, readAttributes } from './challenge.ts';
import { FLAG, NEGOTIATE_FLAGS, NTLM_SIGNATURE } from './flags.ts';
import { negotiateMessage } from './negotiate.ts';

const PASSWORD = 'canary-winrm-password';
const NOW = 1_700_000_000_000;

function random(bytes: number): Buffer {
  return Buffer.alloc(bytes, 0xaa);
}

interface Exchange {
  readonly server: FakeNtlm;
  readonly negotiate: Buffer;
  readonly message: Buffer;
  readonly exportedSessionKey: Buffer;
}

function exchange(
  options: { timestamped?: boolean; keyExchange?: boolean; channelBinding?: Buffer } = {},
  login = String.raw`DOMAIN\vaultgate`,
  password = PASSWORD,
): Exchange {
  const server = new FakeNtlm({ password: PASSWORD, ...options });
  const negotiate = negotiateMessage();
  const separator = login.indexOf('\\');
  const authentication = authenticateMessage({
    credential:
      separator === -1
        ? { username: login, domain: '', password }
        : { username: login.slice(separator + 1), domain: login.slice(0, separator), password },
    challenge: parseChallenge(server.challenge(negotiate)),
    negotiate,
    channelBinding: options.channelBinding,
    random,
    now: () => NOW,
  });
  return { server, negotiate, ...authentication };
}

/**
The attribute list inside the NTLMv2 blob: past the proof, the header, the timestamp and the reserved word.
*/
function blobAttributesOf(message: Buffer): readonly { readonly id: number }[] {
  const nt = message.subarray(
    message.readUInt32LE(24),
    message.readUInt32LE(24) + message.readUInt16LE(20),
  );
  return readAttributes(nt.subarray(16 + 28));
}

describe('the NTLM negotiate message', () => {
  it('ACT-89 asks for Unicode, NTLM, sealing, signing, 128-bit keys and key exchange', () => {
    const message = negotiateMessage();
    expect(message).toHaveLength(40);
    expect(message.subarray(0, 8)).toStrictEqual(NTLM_SIGNATURE);
    expect(message.readUInt32LE(8)).toBe(1);
    expect(message.readUInt32LE(12) >>> 0).toBe(NEGOTIATE_FLAGS >>> 0);
    for (const flag of [FLAG.unicode, FLAG.seal, FLAG.sign, FLAG.key128, FLAG.keyExchange]) {
      expect(message.readUInt32LE(12) & flag).toBe(flag);
    }
  });

  it('ACT-89 names neither a domain nor a workstation, and declares no operating system', () => {
    const message = negotiateMessage();
    expect(message.subarray(16, 32)).toStrictEqual(Buffer.alloc(16));
    expect(message.subarray(32, 40)).toStrictEqual(Buffer.from('000000000000000f', 'hex'));
  });
});

describe('the NTLM authenticate message', () => {
  it('ACT-89 is accepted by a destination that knows the password', () => {
    const { server, message } = exchange();
    expect(server.accept(message)).toBeDefined();
  });

  it('ACT-89 is refused by a destination when the password is wrong', () => {
    const { server, message } = exchange({}, String.raw`DOMAIN\vaultgate`, 'canary-wrong');
    expect(server.accept(message)).toBeUndefined();
  });

  it('ACT-89 carries the account and its authority separately, in UTF-16LE', () => {
    const { message } = exchange();
    const at = (field: number): Buffer =>
      message.subarray(
        message.readUInt32LE(field + 4),
        message.readUInt32LE(field + 4) + message.readUInt16LE(field),
      );
    expect(at(28).toString('utf16le')).toBe('DOMAIN');
    expect(at(36).toString('utf16le')).toBe('vaultgate');
    // No workstation is named, so the field is empty.
    expect(at(44)).toHaveLength(0);
  });

  it('ACT-89 works for a bare local account, which is what a workgroup host has', () => {
    const { server, message } = exchange({}, 'vaultgate');
    expect(server.accept(message)).toBeDefined();
    expect(message.readUInt16LE(28)).toBe(0);
  });

  it('ACT-89 writes a MIC over all three messages when the challenge is timestamped', () => {
    const { server, message } = exchange({ timestamped: true });
    expect(message.subarray(72, 88)).not.toStrictEqual(Buffer.alloc(16));
    // `accept` recomputes the MIC and throws when it does not verify.
    expect(server.accept(message)).toBeDefined();
    const tampered = Buffer.from(message);
    tampered.writeUInt8(tampered.readUInt8(72) ^ 0xff, 72);
    expect(() => server.accept(tampered)).toThrow('the client MIC does not verify');
  });

  it('ACT-89 leaves the MIC zero when the destination sent no timestamp', () => {
    expect(exchange({}).message.subarray(72, 88)).toStrictEqual(Buffer.alloc(16));
  });

  it('ACT-89 carries the channel binding in the blob when the connection had a certificate', () => {
    const token = Buffer.alloc(16, 0x5a);
    const bound = blobAttributesOf(exchange({ channelBinding: token }).message);
    expect(bound.at(-1)).toStrictEqual({ id: AV_CHANNEL_BINDINGS, value: token });
  });

  it('ACT-89 carries no channel binding over a plain connection, which has no channel to bind', () => {
    const plain = blobAttributesOf(exchange().message);
    expect(plain.map((pair) => pair.id)).not.toContain(AV_CHANNEL_BINDINGS);
  });

  it('ACT-89 sends the session key sealed when key exchange is offered, and none when it is not', () => {
    const exchanged = exchange({});
    expect(exchanged.message.readUInt16LE(52)).toBe(16);
    expect(exchanged.exportedSessionKey).toStrictEqual(random(16));
    const direct = exchange({ keyExchange: false });
    expect(direct.message.readUInt16LE(52)).toBe(0);
    expect(direct.exportedSessionKey).not.toStrictEqual(random(16));
    expect(direct.server.accept(direct.message)).toBeDefined();
  });
});
