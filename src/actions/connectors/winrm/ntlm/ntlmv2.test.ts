import { describe, expect, it } from 'vitest';

import { writeAttributes } from './challenge.ts';
import {
  fileTime,
  ntlmCredential,
  ntlmv2Blob,
  ntlmv2Response,
  ntowfv2,
  type NtlmCredential,
} from './ntlmv2.ts';

/**
 * MS-NLMP 4.2.4, "NTLMv2 Authentication", verbatim: the common values of
 * 4.2.1 and every intermediate the worked example prints. Taking the
 * expectations from the specification rather than from vaultgate's own fake
 * destination is the point — a misreading of the construction cannot be
 * mirrored in both.
 */
const CREDENTIAL: NtlmCredential = { username: 'User', domain: 'Domain', password: 'Password' };
const SERVER_CHALLENGE = Buffer.from('0123456789abcdef', 'hex');
const CLIENT_CHALLENGE = Buffer.from('aaaaaaaaaaaaaaaa', 'hex');
const TIME = Buffer.alloc(8);

/**
MS-NLMP 4.2.4.1.3: `MsvAvNbDomainName` "Domain" then `MsvAvNbComputerName` "Server".
*/
const TARGET_INFO = writeAttributes([
  { id: 0x00_02, value: Buffer.from('Domain', 'utf16le') },
  { id: 0x00_01, value: Buffer.from('Server', 'utf16le') },
]);

const NTOWFV2 = '0c868a403bfd7a93a3001ef22ef02e3f';
const NT_PROOF = '68cd0ab851e51c96aabc927bebef6a1c';
// MS-NLMP 4.2.4.1.2. It is a published example value, not a secret.
const SESSION_BASE = '8de40ccadbc14a82f15cb0ad0de95ca3';
const LMV2_RESPONSE = '86c35097ac9cec102554764a57cccc19';

const NT_RESPONSE =
  '68cd0ab851e51c96aabc927bebef6a1c' +
  '01010000000000000000000000000000' +
  'aaaaaaaaaaaaaaaa0000000002000c00' +
  '44006f006d00610069006e0001000c00' +
  '53006500720076006500720000000000' +
  '00000000';

function response(isTimestamped: boolean): ReturnType<typeof ntlmv2Response> {
  return ntlmv2Response({
    key: ntowfv2(CREDENTIAL),
    serverChallenge: SERVER_CHALLENGE,
    clientChallenge: CLIENT_CHALLENGE,
    blob: ntlmv2Blob({
      timestamp: TIME,
      clientChallenge: CLIENT_CHALLENGE,
      attributes: TARGET_INFO,
    }),
    isTimestamped,
  });
}

describe('the NTLMv2 response', () => {
  it('ACT-89 derives NTOWFv2 as MS-NLMP 4.2.4.1.1 prints it', () => {
    expect(ntowfv2(CREDENTIAL).toString('hex')).toBe(NTOWFV2);
  });

  it('ACT-89 builds the NTLMv2 response and session base key of MS-NLMP 4.2.4.2.2', () => {
    const computed = response(false);
    expect(computed.nt.toString('hex')).toBe(NT_RESPONSE);
    expect(computed.nt.subarray(0, 16).toString('hex')).toBe(NT_PROOF);
    expect(computed.sessionBaseKey.toString('hex')).toBe(SESSION_BASE);
  });

  it('ACT-89 builds the LMv2 response of MS-NLMP 4.2.4.2.1 when the challenge is not timestamped', () => {
    expect(response(false).lm.toString('hex')).toBe(LMV2_RESPONSE + 'aaaaaaaaaaaaaaaa');
  });

  it('ACT-89 zeroes the LM response when the challenge is timestamped, because the MIC proves it', () => {
    expect(response(true).lm).toStrictEqual(Buffer.alloc(24));
  });

  it('ACT-89 upper-cases the user name but not the domain, as MS-NLMP 3.3.2 says', () => {
    const shouted = ntowfv2({ ...CREDENTIAL, username: 'USER' });
    expect(shouted.toString('hex')).toBe(NTOWFV2);
    expect(ntowfv2({ ...CREDENTIAL, domain: 'DOMAIN' }).toString('hex')).not.toBe(NTOWFV2);
  });

  it('ACT-89 reads a bare login as a local account and a backslash as its authority', () => {
    expect(ntlmCredential('vaultgate', 'secret')).toStrictEqual({
      username: 'vaultgate',
      domain: '',
      password: 'secret',
    });
    expect(ntlmCredential(String.raw`DOMAIN\vaultgate`, 'secret')).toStrictEqual({
      username: 'vaultgate',
      domain: 'DOMAIN',
      password: 'secret',
    });
    // A user principal name has no backslash and travels whole.
    expect(ntlmCredential('vaultgate@example.com', 'secret').domain).toBe('');
  });

  it('ACT-89 writes a FILETIME of 100-nanosecond intervals since 1601', () => {
    expect(fileTime(0).readBigUInt64LE(0)).toBe(116_444_736_000_000_000n);
    expect(fileTime(1000).readBigUInt64LE(0) - fileTime(0).readBigUInt64LE(0)).toBe(10_000_000n);
  });
});
