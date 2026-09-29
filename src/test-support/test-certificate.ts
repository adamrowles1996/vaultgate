import { X509Certificate } from 'node:crypto';

import type { PeerCertificate } from 'node:tls';

/**
A self-signed test certificate for `db.example.com` (no private key kept), for checks that parse a PEM.
*/
export const TEST_CERTIFICATE_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'MIIBozCCAUqgAwIBAgIUPrBDN+NJwBSyhCI0LKjZpd8xRVAwCgYIKoZIzj0EAwIw',
  'GTEXMBUGA1UEAwwOZGIuZXhhbXBsZS5jb20wIBcNMjYwOTI1MDg0OTE3WhgPMjEy',
  'NjA5MDEwODQ5MTdaMBkxFzAVBgNVBAMMDmRiLmV4YW1wbGUuY29tMFkwEwYHKoZI',
  'zj0CAQYIKoZIzj0DAQcDQgAEGGhiRc7I3RdERwNOdhH2uwmFDaUy6Z49O7ueJB/7',
  'jsZqCr2l3+Pvl1zhl+yqbZ4dQvsTDSCLiUTkNg4vLlhKqKNuMGwwHQYDVR0OBBYE',
  'FE5g36uFi67dMBnlfhUOvAu1iyfPMB8GA1UdIwQYMBaAFE5g36uFi67dMBnlfhUO',
  'vAu1iyfPMA8GA1UdEwEB/wQFMAMBAf8wGQYDVR0RBBIwEIIOZGIuZXhhbXBsZS5j',
  'b20wCgYIKoZIzj0EAwIDRwAwRAIgTATLYG+IwkUAWNqt+jOwPr0MitCrG0Cj1mbX',
  '0pVVbVACIGXoJzuuPsx1q1kw9Au4yEJXTHhlUtZ1NnuXRIyQSWDF',
  '-----END CERTIFICATE-----',
].join('\n');

/**
 * The test certificate as Node's identity check reads it (`tls.checkServerIdentity`),
 * naming these subject-alternative names in place of its own: what a test of
 * the IP-address check of ACT-122 needs, with no second certificate to keep.
 */
export function certificateNaming(subjectaltname: string): PeerCertificate {
  return { ...new X509Certificate(TEST_CERTIFICATE_PEM).toLegacyObject(), subjectaltname };
}
