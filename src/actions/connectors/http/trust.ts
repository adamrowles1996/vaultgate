/**
 * The private trust of an `http` destination on the wire (ACT-121, ACT-122):
 * the certificate pin or the private certificate authority its document
 * names, as the fields of a `PinnedRequest` that carry them. `run` gives them
 * to the requests it sends to `base_url` — the first and every redirect hop —
 * and to nothing else, so a token endpoint exchange keeps the system store
 * (ACT-123).
 */
import { pinnedCertificateCheck } from '../../../net/certificate-pin.ts';

import type { HttpDestination } from './schemas.ts';
import type { PinnedRequest } from '../../../net/pinned-https.ts';

export type DestinationTrust = Pick<PinnedRequest, 'certificate' | 'ca'>;

/**
Nothing when the destination names neither, which leaves the system store in charge.
*/
export function destinationTrust(destination: HttpDestination): DestinationTrust {
  if (destination.certificate_sha256 !== undefined) {
    return { certificate: pinnedCertificateCheck(destination.certificate_sha256) };
  }
  return destination.ca_pem === undefined ? {} : { ca: destination.ca_pem };
}
