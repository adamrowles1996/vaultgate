export type ClientIpResolver = (request: Request) => string;

export interface ClientIpOptions {
  /**
  `VAULTGATE_TRUST_PROXY`: honour `X-Forwarded-For` from the upstream.
  */
  readonly trustProxy: boolean;
  /**
  The socket peer address; supplied by the listener, absent in tests.
  */
  readonly socketAddress: (request: Request) => string | undefined;
}

const UNKNOWN_ADDRESS = 'unknown';

/**
 * OPS-6: forwarded headers are ignored unless the proxy is trusted, so a
 * client cannot spread its requests over spoofed addresses.
 */
export function createClientIpResolver(options: ClientIpOptions): ClientIpResolver {
  return (request) => {
    if (options.trustProxy) {
      const forwarded = request.headers.get('x-forwarded-for');
      const first = forwarded?.split(',', 1)[0]?.trim();
      if (first !== undefined && first.length > 0) {
        return first;
      }
    }
    return options.socketAddress(request) ?? UNKNOWN_ADDRESS;
  };
}
