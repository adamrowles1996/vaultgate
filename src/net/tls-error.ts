/**
 * Whether a transport error code names a certificate or TLS failure
 * (ACT-57, §13.16): OpenSSL's verification codes and Node's own TLS codes.
 * One rule, so every connector that opens a TLS connection — the pinned
 * HTTPS transport and the database drivers — answers `tls_error` for the
 * same failures and `connection_failed` for the rest.
 */
const TLS_CODE =
  /^(?:ERR_TLS_|ERR_SSL_|ERR_OSSL_|CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_SELF_SIGNED_CERT$|HOSTNAME_MISMATCH$|EPROTO$)/u;

export function isTlsErrorCode(code: string): boolean {
  return TLS_CODE.test(code);
}
