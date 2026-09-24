/**
 * The `NEGOTIATE_MESSAGE` (MS-NLMP 2.2.1.1), the first of the three NTLM
 * messages and the only one that carries nothing but flags: vaultgate names
 * neither a domain nor a workstation, so both fields stay empty and the
 * server learns nothing about the host it is talking to until it has issued a
 * challenge. The bytes are kept, because the MIC of the third message is
 * taken over all three (MS-NLMP 3.1.5.1.2).
 */
import { MESSAGE_NEGOTIATE, NEGOTIATE_FLAGS, NTLM_SIGNATURE, VERSION } from './flags.ts';

const TYPE_AT = 8;
const FLAGS_AT = 12;
/**
 * Bytes 16 to 31 are the domain and workstation triples. They stay zero:
 * vaultgate supplies neither name, so each is a zero-length field at offset
 * zero, which is what MS-NLMP 2.2.1.1 asks for when the flags do not claim one.
 */
const VERSION_AT = 32;
const NEGOTIATE_BYTES = 40;

export function negotiateMessage(): Buffer {
  const message = Buffer.alloc(NEGOTIATE_BYTES);
  NTLM_SIGNATURE.copy(message);
  message.writeUInt32LE(MESSAGE_NEGOTIATE, TYPE_AT);
  message.writeUInt32LE(NEGOTIATE_FLAGS >>> 0, FLAGS_AT);
  VERSION.copy(message, VERSION_AT);
  return message;
}
