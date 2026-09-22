import { z } from 'zod';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const MIN_SECRET_KEY_BYTES = 32;
const HEX = /^[0-9a-f]+$/i;
const BASE64_ALPHABET = /^[\w+/=-]+$/;

/**
Booleans arrive as text; `1`/`0` are accepted for Compose-style files.
*/
export function booleanSchema(fallback: 'true' | 'false'): z.ZodType<boolean, string | undefined> {
  return z
    .enum(['true', 'false', '1', '0'])
    .default(fallback)
    .transform((value) => value === 'true' || value === '1');
}

function isWebProtocol(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

function parseUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

/**
A bare origin: scheme and host only, no path, query or fragment.
*/
export function toOrigin(text: string): string | undefined {
  const url = parseUrl(text);
  if (url === undefined || !isWebProtocol(url)) {
    return undefined;
  }
  return url.pathname !== '/' || url.search !== '' || url.hash !== '' ? undefined : url.origin;
}

export const originListSchema: z.ZodType<readonly string[], string | undefined> = z
  .string()
  .default('')
  .transform((text, context) => {
    const origins: string[] = [];
    for (const entry of text.split(',')) {
      const trimmed = entry.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const origin = toOrigin(trimmed);
      if (origin === undefined) {
        context.addIssue({
          code: 'custom',
          message: `"${trimmed}" is not an origin such as https://app.example.com`,
        });
        return z.NEVER;
      }
      origins.push(origin);
    }
    return origins;
  });

export interface PublicUrlProblem {
  readonly message: string;
}

/**
Normalises the public URL: web scheme, https unless loopback, no query, no trailing slash.
*/
export function normalisePublicUrl(text: string): string | PublicUrlProblem {
  const url = parseUrl(text);
  if (url === undefined || !isWebProtocol(url)) {
    return { message: 'must be an absolute http(s) URL' };
  }
  if (url.search !== '' || url.hash !== '') {
    return { message: 'must not contain a query string or fragment' };
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return { message: 'must use https unless the host is loopback' };
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path}`;
}

export const publicUrlSchema: z.ZodType<string, string> = z.string().transform((text, context) => {
  const result = normalisePublicUrl(text);
  if (typeof result === 'string') {
    return result;
  }
  context.addIssue({ code: 'custom', message: result.message });
  return z.NEVER;
});

/**
Decodes a hex or base64(url) key of at least 32 bytes.
*/
export function decodeSecretKey(text: string): Buffer | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0 || !BASE64_ALPHABET.test(trimmed)) {
    return undefined;
  }
  const isHex = HEX.test(trimmed) && trimmed.length % 2 === 0;
  const key = Buffer.from(trimmed, isHex ? 'hex' : 'base64');
  return key.length >= MIN_SECRET_KEY_BYTES ? key : undefined;
}

export const secretKeySchema: z.ZodType<Buffer, string> = z.string().transform((text, context) => {
  const key = decodeSecretKey(text);
  if (key === undefined) {
    context.addIssue({
      code: 'custom',
      message: `must be hex or base64 and decode to at least ${MIN_SECRET_KEY_BYTES} bytes`,
    });
    return z.NEVER;
  }
  return key;
});

export interface PreregisteredClient {
  readonly clientId: string;
  readonly clientName: string | undefined;
  readonly redirectUris: readonly string[];
}

const preregisteredClientSchema = z.object({
  client_id: z.string().min(1),
  client_name: z.string().min(1).optional(),
  redirect_uris: z.array(z.url()).min(1),
});

function parseJson(text: string, context: z.RefinementCtx): unknown {
  try {
    return JSON.parse(text);
  } catch {
    context.addIssue({ code: 'custom', message: 'must be valid JSON' });
    return z.NEVER;
  }
}

export const preregisteredClientsSchema: z.ZodType<
  readonly PreregisteredClient[],
  string | undefined
> = z
  .string()
  .default('[]')
  .transform(parseJson)
  .pipe(z.array(preregisteredClientSchema))
  .transform((clients) =>
    clients.map((client) => ({
      clientId: client.client_id,
      clientName: client.client_name,
      redirectUris: client.redirect_uris,
    })),
  );

function isBitwardenServer(text: string): boolean {
  if (text === 'bitwarden.eu') {
    return true;
  }
  const url = parseUrl(text);
  return url?.protocol === 'https:';
}

export const bitwardenServerSchema: z.ZodType<string | undefined, string | undefined> = z
  .string()
  .refine(isBitwardenServer, 'must be bitwarden.eu or an https:// URL')
  .optional();
