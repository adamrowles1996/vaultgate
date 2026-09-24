import { describe, expect, it } from 'vitest';

import {
  FakeNtlm,
  FAKE_SERVER_CHALLENGE,
  FAKE_TIMESTAMP,
} from '../../../../test-support/fake-ntlm.ts';

import {
  blobAttributes,
  parseChallenge,
  readAttributes,
  withMicAnnounced,
  writeAttributes,
  type AvPair,
} from './challenge.ts';
import { FLAG, REQUIRED_FLAGS } from './flags.ts';
import { negotiateMessage } from './negotiate.ts';
import { NtlmProblem } from './reader.ts';

function challengeFrom(options: { timestamped?: boolean; flags?: number }): Buffer {
  return new FakeNtlm({ password: 'canary-winrm-password', ...options }).challenge(
    negotiateMessage(),
  );
}

describe('the NTLM challenge message', () => {
  it('ACT-89 reads the server challenge, the flags and the attributes a destination sent', () => {
    const parsed = parseChallenge(challengeFrom({}));
    expect(parsed.serverChallenge).toStrictEqual(FAKE_SERVER_CHALLENGE);
    expect(parsed.flags & FLAG.keyExchange).toBe(FLAG.keyExchange);
    expect(parsed.attributes.map((pair) => pair.id)).toStrictEqual([0x00_02, 0x00_01]);
    expect(parsed.timestamp).toBeUndefined();
  });

  it('ACT-89 reads the timestamp attribute a Windows host sends', () => {
    expect(parseChallenge(challengeFrom({ timestamped: true })).timestamp).toStrictEqual(
      FAKE_TIMESTAMP,
    );
  });

  it('T33 refuses a message that is not a challenge, truncated or otherwise malformed', () => {
    const good = challengeFrom({});
    expect(() => parseChallenge(Buffer.alloc(0))).toThrow(NtlmProblem);
    expect(() => parseChallenge(Buffer.alloc(48, 0x41))).toThrow(
      'it does not begin with the NTLMSSP signature',
    );
    const wrongType = Buffer.from(good);
    wrongType.writeUInt32LE(3, 8);
    expect(() => parseChallenge(wrongType)).toThrow('it is not a challenge');
    expect(() => parseChallenge(good.subarray(0, 44))).toThrow(NtlmProblem);
    const pastEnd = Buffer.from(good);
    pastEnd.writeUInt32LE(good.length + 1, 44);
    expect(() => parseChallenge(pastEnd)).toThrow(NtlmProblem);
  });

  it('ACT-89 refuses a challenge that would downgrade the exchange', () => {
    const weak = challengeFrom({ flags: REQUIRED_FLAGS & ~FLAG.seal });
    expect(() => parseChallenge(weak)).toThrow(
      'it offers neither Unicode, extended session security, sealing, signing nor 128-bit keys',
    );
  });

  it('T33 refuses an attribute list that runs past its buffer, never terminates, or lies', () => {
    expect(() => readAttributes(Buffer.alloc(0))).toThrow(NtlmProblem);
    const unterminated = writeAttributes([{ id: 0x00_01, value: Buffer.from('a') }]).subarray(0, 5);
    expect(() => readAttributes(unterminated)).toThrow(NtlmProblem);
    const terminatorWithValue = Buffer.from('00000200aaaa', 'hex');
    expect(() => readAttributes(terminatorWithValue)).toThrow(
      'the terminating attribute carries a value',
    );
    const many = writeAttributes(
      Array.from({ length: 70 }, () => ({ id: 0x00_01, value: Buffer.alloc(0) })),
    );
    expect(() => readAttributes(many)).toThrow(
      'the target information holds more attributes than any challenge does',
    );
  });

  it('T33 refuses a timestamp or flags attribute that is the wrong width', () => {
    const shortTimestamp = writeAttributes([{ id: 0x00_07, value: Buffer.alloc(4) }]);
    expect(() => readAttributes(shortTimestamp)).not.toThrow();
    const message = challengeFrom({});
    const rebuilt = rebuildAttributes(message, shortTimestamp);
    expect(() => parseChallenge(rebuilt)).toThrow('the timestamp attribute is not eight bytes');
    expect(() => withMicAnnounced([{ id: 0x00_06, value: Buffer.alloc(2) }])).toThrow(
      'the flags attribute is not four bytes',
    );
  });

  it('ACT-89 round-trips an attribute list through its own writer', () => {
    const pairs: readonly AvPair[] = [
      { id: 0x00_02, value: Buffer.from('WORKGROUP', 'utf16le') },
      { id: 0x00_01, value: Buffer.from('SERVER', 'utf16le') },
    ];
    expect(readAttributes(writeAttributes(pairs))).toStrictEqual(pairs);
  });

  it('ACT-89 announces the MIC in the blob only when the destination timestamped its challenge', () => {
    const bare = parseChallenge(challengeFrom({}));
    expect(blobAttributes(bare)).toStrictEqual(writeAttributes(bare.attributes));
    const timestamped = parseChallenge(challengeFrom({ timestamped: true }));
    const announced = readAttributes(blobAttributes(timestamped));
    expect(announced.at(-1)).toStrictEqual({
      id: 0x00_06,
      value: Buffer.from('02000000', 'hex'),
    });
  });

  it('ACT-89 keeps an existing flags attribute in place, adding only the MIC bit', () => {
    const announced = withMicAnnounced([
      { id: 0x00_06, value: Buffer.from('01000000', 'hex') },
      { id: 0x00_01, value: Buffer.from('SERVER', 'utf16le') },
    ]);
    expect(announced.map((pair) => pair.id)).toStrictEqual([0x00_06, 0x00_01]);
    expect(announced[0]?.value).toStrictEqual(Buffer.from('03000000', 'hex'));
  });
});

/**
Puts a different attribute list into a challenge, keeping its header intact.
*/
function rebuildAttributes(message: Buffer, attributes: Buffer): Buffer {
  const head = message.subarray(0, message.readUInt32LE(44));
  const rebuilt = Buffer.concat([head, attributes]);
  rebuilt.writeUInt16LE(attributes.length, 40);
  rebuilt.writeUInt16LE(attributes.length, 42);
  return rebuilt;
}
