import { fail, ok, type Result } from '../result.ts';

/**
 * OAUTH-6: loopback hosts that may use plain `http`.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * OAUTH-7 / RFC 8252 §7.3: only the literal loopback addresses get the
 * variable-port exception; `localhost` does not, because it may resolve
 * anywhere.
 */
const LOOPBACK_LITERALS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]']);

export class RedirectUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedirectUriError';
  }
}

function parse(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * OAUTH-6: `https://…` or a loopback `http://` address, absolute, without a
 * fragment (RFC 6749 §3.1.2) and without embedded credentials.
 */
export function validateRedirectUri(text: string): Result<string, RedirectUriError> {
  const url = parse(text);
  if (url === undefined) {
    return fail(new RedirectUriError(`redirect URI "${text}" is not an absolute URL`));
  }
  if (url.hash !== '' || text.endsWith('#')) {
    return fail(new RedirectUriError(`redirect URI "${text}" must not contain a fragment`));
  }
  if (url.username !== '' || url.password !== '') {
    return fail(new RedirectUriError(`redirect URI "${text}" must not contain credentials`));
  }
  if (url.protocol !== 'https:' && !isLoopbackHttp(url)) {
    return fail(
      new RedirectUriError(`redirect URI "${text}" must use https or a loopback http address`),
    );
  }
  return ok(text);
}

export function isLoopbackRedirect(text: string): boolean {
  const url = parse(text);
  return url !== undefined && isLoopbackHttp(url);
}

/**
 * The host as the consent page shows it: hostname plus explicit port (OAUTH-13).
 */
export function redirectHost(text: string): string {
  const url = parse(text);
  return url === undefined ? text : url.host;
}

function matchesWithLoopbackPortException(requested: string, registered: string): boolean {
  const requestedUrl = parse(requested);
  const registeredUrl = parse(registered);
  if (requestedUrl === undefined || registeredUrl === undefined) {
    return false;
  }
  if (!LOOPBACK_LITERALS.has(requestedUrl.hostname) || requestedUrl.protocol !== 'http:') {
    return false;
  }
  return (
    requestedUrl.protocol === registeredUrl.protocol &&
    requestedUrl.hostname === registeredUrl.hostname &&
    requestedUrl.pathname === registeredUrl.pathname &&
    requestedUrl.search === registeredUrl.search
  );
}

/**
 * OAUTH-7: exact string comparison, with the RFC 8252 loopback-port
 * exception applied only when the requested URI is a loopback literal.
 */
export function matchesRegisteredRedirect(
  requested: string,
  registered: readonly string[],
): boolean {
  return registered.some(
    (candidate) =>
      candidate === requested || matchesWithLoopbackPortException(requested, candidate),
  );
}
