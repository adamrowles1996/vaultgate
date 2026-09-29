/**
 * What a token endpoint's answer means (spec §14.3a, ACT-126), for `graph`
 * and `oauth2` alike. The body is validated against a schema before a field
 * is read (T33). A 2xx JSON object with a non-empty `access_token` is a
 * grant; a 2xx body that carries `error` and no token is a refusal like any
 * non-2xx answer, because some endpoints (Zoho Books) answer a refused
 * refresh token with `200`. `token_type` is never read: the operator's
 * prefix decides the scheme (ACT-128).
 *
 * Only an OAuth error code of a fixed shape reaches `detail`: the
 * `error_description` beside it often quotes the request (Microsoft's AADSTS
 * text does), and nothing that can echo the client secret or a refresh token
 * is scrub-safe enough to pass on.
 */
import { z } from 'zod';

import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

const SECOND_MS = 1000;

/**
ACT-126: the lifetime assumed when a grant carries no `expires_in`, short enough that a token is never kept long past a lifetime vaultgate was not told.
*/
export const DEFAULT_LIFETIME_S = 300;

/**
The refusals that are the credential's fault; every other answer is the endpoint's (ACT-126).
*/
const AUTHENTICATION_ERRORS: ReadonlySet<string> = new Set([
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'invalid_code',
]);

/**
An OAuth error code as `detail` may carry it: letters, digits, `_`, `.` and `-`, at most 64.
*/
const ERROR_CODE = /^[\w.-]{1,64}$/;

/**
`expires_in` as a positive integer, or as a string of digits (some endpoints quote it).
*/
const lifetimeSchema = z.union([
  z.number().int().positive(),
  z
    .string()
    .regex(/^\d{1,15}$/)
    .transform(Number)
    .pipe(z.number().int().positive()),
]);

const grantSchema = z.object({
  access_token: z.string().min(1),
  expires_in: lifetimeSchema.nullish(),
  refresh_token: z.string().min(1).nullish(),
});

const refusalSchema = z.object({ error: z.string().min(1) });

const errorCodeSchema = z.object({ error: z.string().regex(ERROR_CODE) });

export interface TokenGrant {
  readonly accessToken: string;
  readonly expiresInMs: number;
  /**
  The refresh token the endpoint returned, if any; ACT-127 writes it back when it differs from the one the call holds.
  */
  readonly refreshToken: string | undefined;
}

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
ACT-126: the credential's fault with its code, or the endpoint's with its status and, when it has a well-formed one, its code.
*/
function refusal(status: number, body: unknown): ActionError {
  const parsed = errorCodeSchema.safeParse(body);
  if (!parsed.success) {
    return new ActionError('upstream_error', { status });
  }
  const { error } = parsed.data;
  return AUTHENTICATION_ERRORS.has(error)
    ? new ActionError('authentication_failed', { error })
    : new ActionError('upstream_error', { status, error });
}

/**
The token endpoint's answer as a grant, or as the refusal or malformed answer it is.
*/
export function tokenOutcome(response: Response, raw: Buffer): Result<TokenGrant, ActionError> {
  const body = parseJson(raw);
  if (!response.ok) {
    return fail(refusal(response.status, body));
  }
  const grant = grantSchema.safeParse(body);
  if (grant.success) {
    const { access_token: accessToken, expires_in: lifetime, refresh_token: refresh } = grant.data;
    return ok({
      accessToken,
      expiresInMs: (lifetime ?? DEFAULT_LIFETIME_S) * SECOND_MS,
      refreshToken: refresh ?? undefined,
    });
  }
  return fail(
    refusalSchema.safeParse(body).success
      ? refusal(response.status, body)
      : new ActionError('upstream_error', { reason: 'invalid_token_response' }),
  );
}
