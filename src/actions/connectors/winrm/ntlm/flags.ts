/**
 * The NTLM message header and the negotiate flags vaultgate actually supports
 * (MS-NLMP 2.2.2.5). The set is deliberately narrow: NTLMv2 with extended
 * session security, sealing and signing at 128 bits, and nothing older. A
 * destination that will not agree to those is refused rather than met
 * half-way — the point of speaking NTLM here is that the password never
 * crosses the network and the payload is encrypted (ACT-89), and every flag
 * below is part of one of those two promises.
 */
export const NTLM_SIGNATURE = Buffer.from('NTLMSSP\u{0}', 'latin1');

export const MESSAGE_NEGOTIATE = 1;
export const MESSAGE_CHALLENGE = 2;
export const MESSAGE_AUTHENTICATE = 3;

export const FLAG = {
  /**
  The names, the domain and the target information are UTF-16LE; vaultgate speaks nothing else.
  */
  unicode: 0x00_00_00_01,
  requestTarget: 0x00_00_00_04,
  sign: 0x00_00_00_10,
  seal: 0x00_00_00_20,
  ntlm: 0x00_00_02_00,
  alwaysSign: 0x00_00_80_00,
  /**
  NTLMv2's HMAC construction; without it the exchange falls back to primitives vaultgate will not use.
  */
  extendedSessionSecurity: 0x00_08_00_00,
  targetInfo: 0x00_80_00_00,
  version: 0x02_00_00_00,
  key128: 0x20_00_00_00,
  /**
  The client, not the server, chooses the exported session key and sends it sealed (MS-NLMP 3.1.5.1.2).
  */
  keyExchange: 0x40_00_00_00,
} as const;

/**
What the Type 1 message asks for.
*/
export const NEGOTIATE_FLAGS =
  FLAG.unicode |
  FLAG.requestTarget |
  FLAG.sign |
  FLAG.seal |
  FLAG.ntlm |
  FLAG.alwaysSign |
  FLAG.extendedSessionSecurity |
  FLAG.targetInfo |
  FLAG.version |
  FLAG.key128 |
  FLAG.keyExchange;

/**
 * What the challenge has to agree to before vaultgate will answer it. Key
 * exchange is not on the list: the specification lets a server decline it, and
 * both paths derive a usable session key. Everything else is load-bearing —
 * without `seal` and `sign` there is no message encryption to offer a host
 * with `AllowUnencrypted=false`, and without extended session security the
 * responses would not be NTLMv2 at all.
 */
export const REQUIRED_FLAGS =
  FLAG.unicode | FLAG.sign | FLAG.seal | FLAG.extendedSessionSecurity | FLAG.key128;

/**
 * MS-NLMP 2.2.2.10: the eight bytes an `AUTHENTICATE_MESSAGE` carries before
 * the MIC, which sits at a fixed offset behind them. vaultgate is not Windows
 * and declares no operating-system version — the three version bytes stay
 * zero rather than claiming a build it is not — but the field itself has to be
 * there, because a receiver looks for the MIC at offset 72 whatever precedes
 * it. The last byte is `NTLMSSP_REVISION_W2K3`, the current revision.
 */
export const VERSION = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0x0f]);
