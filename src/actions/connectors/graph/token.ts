/**
 * The token exchange of ACT-82: one form post to
 * `https://login.microsoftonline.com/<tenant_id>/oauth2/v2.0/token` through
 * the pinned transport, its response zod-validated before a field is read
 * (T33), and its failures mapped onto the §13.16 codes. The AADSTS
 * description that accompanies an error is not scrub-safe — it quotes the
 * request — so only the OAuth error code reaches `detail`.
 */
import { z } from 'zod';

import { readBodyCapped, type PinnedFetch } from '../../../net/pinned-https.ts';
import { fail, ok, type Result } from '../../../result.ts';
import { ActionError } from '../../errors.ts';
import { transportFailure } from '../http/response.ts';

import { GRAPH_TOKEN_HOST, type GraphCredential } from './document.ts';

const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_ERROR_CODE = 64;
const SECOND_MS = 1000;

const AUTHENTICATION_ERRORS: ReadonlySet<string> = new Set(['invalid_client', 'invalid_grant']);

const grantSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
});

const errorSchema = z.object({ error: z.string().min(1).max(MAX_ERROR_CODE) });

export interface TokenRequest {
  readonly credential: GraphCredential;
  readonly clientSecret: string;
  /**
  The current refresh token; required by the `refresh_token` grant and unused by the other.
  */
  readonly refreshToken: string | undefined;
  readonly address: string;
  readonly signal: AbortSignal;
  readonly version: string;
}

export interface TokenGrant {
  readonly accessToken: string;
  readonly expiresInMs: number;
  /**
  Present when Microsoft rotated the refresh token; ACT-83 writes it back before the request runs.
  */
  readonly rotatedRefreshToken: string | undefined;
}

export function tokenUrl(tenantId: string): string {
  return `https://${GRAPH_TOKEN_HOST}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;
}

function formBody(request: TokenRequest): Buffer {
  const { credential } = request;
  const form = new URLSearchParams({
    client_id: credential.client_id,
    client_secret: request.clientSecret,
    scope: credential.scope,
    grant_type: credential.grant,
  });
  if (request.refreshToken !== undefined) {
    form.set('refresh_token', request.refreshToken);
  }
  return Buffer.from(form.toString(), 'utf8');
}

function parseJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
ACT-82: `invalid_client` and `invalid_grant` are the credential's fault; every other answer is the destination's.
*/
function refusal(status: number, raw: Buffer): ActionError {
  const parsed = errorSchema.safeParse(parseJson(raw));
  if (!parsed.success) {
    return new ActionError('upstream_error', { status });
  }
  const { error } = parsed.data;
  return AUTHENTICATION_ERRORS.has(error)
    ? new ActionError('authentication_failed', { error })
    : new ActionError('upstream_error', { status, error });
}

function toGrant(raw: Buffer): Result<TokenGrant, ActionError> {
  const parsed = grantSchema.safeParse(parseJson(raw));
  if (!parsed.success) {
    return fail(new ActionError('upstream_error', { reason: 'invalid_token_response' }));
  }
  return ok({
    accessToken: parsed.data.access_token,
    expiresInMs: parsed.data.expires_in * SECOND_MS,
    rotatedRefreshToken: parsed.data.refresh_token,
  });
}

export async function requestToken(
  transport: PinnedFetch,
  request: TokenRequest,
): Promise<Result<TokenGrant, ActionError>> {
  try {
    const response = await transport({
      url: tokenUrl(request.credential.tenant_id),
      address: request.address,
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        'user-agent': `vaultgate/${request.version}`,
      },
      body: formBody(request),
      signal: request.signal,
    });
    const raw = await readBodyCapped(response, MAX_RESPONSE_BYTES);
    return response.ok ? toGrant(raw) : fail(refusal(response.status, raw));
  } catch (error: unknown) {
    return fail(transportFailure(error, request.signal));
  }
}
