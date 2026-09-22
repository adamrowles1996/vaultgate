/**
 * A cookie jar plus form submission over `app.request()`, so browser flows
 * (setup → login → account) run in-process with no socket (ARCH-5).
 */
export interface RequestTarget {
  request(input: string, init?: RequestInit): Response | Promise<Response>;
}

interface SubmitOptions {
  /**
  `false` sends no Origin header (a cross-site or non-browser client).
  */
  readonly origin?: string | false;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface Browser {
  readonly cookies: Map<string, string>;
  get(path: string, headers?: Readonly<Record<string, string>>): Promise<Response>;
  submit(
    path: string,
    fields: Readonly<Record<string, string>>,
    options?: SubmitOptions,
  ): Promise<Response>;
  /**
  A POST whose body is not a form at all.
  */
  postRaw(path: string, body: string, contentType: string): Promise<Response>;
  /**
  A multipart POST, as a browser sends a form with a file input.
  */
  postMultipart(path: string, form: FormData): Promise<Response>;
}

function storeCookies(jar: Map<string, string>, response: Response): void {
  for (const header of response.headers.getSetCookie()) {
    const [pair = '', ...attributes] = header.split(';', 16);
    const separator = pair.indexOf('=');
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    const isCleared = attributes.some((attribute) => attribute.trim() === 'Max-Age=0');
    if (isCleared) {
      jar.delete(name);
    } else {
      jar.set(name, value);
    }
  }
}

export function createBrowser(
  target: RequestTarget,
  origin = 'https://vault.example.com',
): Browser {
  const cookies = new Map<string, string>();
  const cookieHeader = (): Record<string, string> =>
    cookies.size === 0
      ? {}
      : { cookie: [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') };
  const send = async (path: string, init: RequestInit): Promise<Response> => {
    const response = await target.request(`${origin}${path}`, init);
    storeCookies(cookies, response);
    return response;
  };
  return {
    cookies,
    get: (path, headers = {}) => send(path, { headers: { ...cookieHeader(), ...headers } }),
    submit: (path, fields, options = {}) => {
      const originHeader = options.origin === false ? {} : { origin: options.origin ?? origin };
      return send(path, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          ...cookieHeader(),
          ...originHeader,
          ...options.headers,
        },
        body: new URLSearchParams(fields).toString(),
      });
    },
    postMultipart: (path, form) =>
      send(path, { method: 'POST', headers: { origin, ...cookieHeader() }, body: form }),
    postRaw: (path, body, contentType) =>
      send(path, {
        method: 'POST',
        headers: { 'content-type': contentType, origin, ...cookieHeader() },
        body,
      }),
  };
}
