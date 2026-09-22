import { fail, ok, type Result } from '../result.ts';

import { OAuthError } from './errors.ts';

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded';

export type FormFields = ReadonlyMap<string, string>;

/**
 * Reads a form body (OAUTH §3.1: form-encoded only), rejecting other media
 * types and repeated parameters (RFC 6749 §3.2). The body is capped by the
 * caller.
 */
export async function readForm(
  request: Request,
  maxBytes: number,
): Promise<Result<FormFields, OAuthError>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.split(';', 1)[0]?.trim().toLowerCase() !== FORM_CONTENT_TYPE) {
    return fail(new OAuthError('invalid_request', `the body must be ${FORM_CONTENT_TYPE}`));
  }
  const text = await request.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return fail(new OAuthError('invalid_request', 'the request body is too large'));
  }
  const fields = new Map<string, string>();
  const parameters = new URLSearchParams(text);
  for (const [name, value] of parameters) {
    if (fields.has(name)) {
      return fail(new OAuthError('invalid_request', `parameter "${name}" is repeated`));
    }
    fields.set(name, value);
  }
  return ok(fields);
}

/**
 * Query parameters with the same single-occurrence rule as form bodies.
 */
export function readQuery(url: URL): Result<FormFields, OAuthError> {
  const fields = new Map<string, string>();
  for (const [name, value] of url.searchParams) {
    if (fields.has(name)) {
      return fail(new OAuthError('invalid_request', `parameter "${name}" is repeated`));
    }
    fields.set(name, value);
  }
  return ok(fields);
}

export function requireField(fields: FormFields, name: string): Result<string, OAuthError> {
  const value = fields.get(name);
  return value === undefined || value.length === 0
    ? fail(new OAuthError('invalid_request', `parameter "${name}" is required`))
    : ok(value);
}
