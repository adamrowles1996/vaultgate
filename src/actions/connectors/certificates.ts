/**
 * The destination fields that name a private trust in place of the system
 * store (ACT-57), shared by the connectors that offer them so each is
 * written, normalised and refused the same way wherever it appears: a leaf
 * certificate pin (`certificate_sha256` of `winrm` and `http`, ACT-121) and
 * the certificates of a private authority (`ca_pem` of `sql` and `http`,
 * ACT-122).
 */
import { X509Certificate } from 'node:crypto';

import { z } from 'zod';

const SHA256_HEX = /^[\da-f]{64}$/u;
const SEPARATORS = /[\s:]/gu;

/**
 * ACT-57, ACT-121: the SHA-256 of the DER leaf certificate, as `openssl` and
 * `Get-FileHash` print it — with or without the colons, in either case. It is
 * stored in one form so the comparison at connect time is a string equality.
 */
export const certificateSha256Schema = z.string().transform((text, context) => {
  const digest = text.replaceAll(SEPARATORS, '').toLowerCase();
  if (SHA256_HEX.test(digest)) {
    return digest;
  }
  context.addIssue({
    code: 'custom',
    message: 'must be a SHA-256 fingerprint: 64 hexadecimal digits, colons optional',
  });
  return z.NEVER;
});

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----\r?\n[\s\S]+?\r?\n-----END CERTIFICATE-----/g;

/**
ACT-57, ACT-122: every certificate in the PEM parses. A PEM pasted into a single-line box loses its
line breaks, which no TLS stack reads, and the call would fail as `tls_error` long after the save.
*/
export function isPemCertificates(pem: string): boolean {
  const blocks = pem.match(PEM_CERTIFICATE) ?? [];
  return (
    blocks.length > 0 &&
    blocks.every((block) => {
      try {
        return new X509Certificate(block).subject.length > 0;
      } catch {
        return false;
      }
    })
  );
}

/**
The save-time problem of a `ca_pem` that `isPemCertificates` refuses, saying how to paste one.
*/
export const NOT_PEM_PROBLEM =
  'destination.ca_pem: is not a PEM certificate; paste it with its line breaks, from -----BEGIN CERTIFICATE----- to -----END CERTIFICATE-----';
