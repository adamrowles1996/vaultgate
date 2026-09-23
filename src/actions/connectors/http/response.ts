/**
 * What comes back from the destination (ACT-21) and what a failure to reach
 * it means (§13.16): the visible headers, the body as text or base64, the
 * byte count and the cut at the output limit, and the mapping of transport
 * errors to `timeout`, `tls_error` and `connection_failed`. A non-2xx
 * status, 401 included, is a result, never an error.
 */
import { isUtf8 } from 'node:buffer';

import { ActionError } from '../../errors.ts';

import type { HttpPolicy } from './schemas.ts';
import type { ConnectorOutput } from '../connector.ts';

const BASE64_BLOCK = 4;
const BASE64_BYTES_PER_BLOCK = 3;

const TEXT_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-www-form-urlencoded',
]);

/**
OpenSSL verification failures and the TLS layer's own codes (ACT-57); everything else is the connection.
*/
const TLS_CODE =
  /^(?:ERR_TLS_|ERR_SSL_|ERR_OSSL_|CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_SELF_SIGNED_CERT$|HOSTNAME_MISMATCH$|EPROTO$)/;

/**
 * The rule for `body` (ACT-21): text when the media type is textual (`text/*`,
 * JSON, XML, JavaScript, form-encoded, or none) and the bytes are valid UTF-8;
 * base64 with `body_encoding` otherwise.
 */
function isText(contentType: string | null, bytes: Buffer): boolean {
  if (contentType === null) {
    return isUtf8(bytes);
  }
  const semicolon = contentType.indexOf(';');
  const media = (semicolon === -1 ? contentType : contentType.slice(0, semicolon))
    .trim()
    .toLowerCase();
  const isTextual =
    media.startsWith('text/') ||
    TEXT_MEDIA_TYPES.has(media) ||
    media.endsWith('+json') ||
    media.endsWith('+xml');
  return isTextual && isUtf8(bytes);
}

function visibleHeaders(headers: Headers, names: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = headers.get(name);
      return value === null ? [] : [[name, value] as const];
    }),
  );
}

/**
 * The connector output before the engine scrubs it. Text goes to `captured`
 * as read (the engine scrubs it and cuts it at the limit, ACT-52); a binary
 * body is cut here to the largest base64 that fits the limit, so what the
 * agent receives always decodes.
 */
export function toOutput(
  response: Response,
  raw: Buffer,
  policy: HttpPolicy,
  maxBytes: number,
): ConnectorOutput {
  const common = {
    status: response.status,
    headers: visibleHeaders(response.headers, policy.response_headers),
    bytes: raw.length,
  };
  if (isText(response.headers.get('content-type'), raw)) {
    return { result: { ...common, truncated: raw.length > maxBytes }, captured: { body: raw } };
  }
  const fit = raw.subarray(0, Math.floor(maxBytes / BASE64_BLOCK) * BASE64_BYTES_PER_BLOCK);
  return {
    result: { ...common, body_encoding: 'base64', truncated: raw.length > fit.length },
    captured: { body: Buffer.from(fit.toString('base64'), 'ascii') },
  };
}

function errorCode(error: unknown): string {
  if (error instanceof Error) {
    return 'code' in error && typeof error.code === 'string' ? error.code : error.name;
  }
  return 'unknown';
}

/**
 * ACT-59: an abort is the policy timeout; ACT-57: a certificate or TLS
 * failure is `tls_error`; anything else is `connection_failed`. The detail
 * names the error code only, never an address (ACT-74).
 */
export function transportFailure(error: unknown, signal: AbortSignal): ActionError {
  const code = errorCode(error);
  if (code === 'AbortError' || signal.aborted) {
    return new ActionError('timeout');
  }
  return new ActionError(TLS_CODE.test(code) ? 'tls_error' : 'connection_failed', {
    reason: code,
  });
}
