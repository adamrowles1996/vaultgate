/**
 * The token exchange of ACT-82 and ACT-125: one form post to the plan's
 * token endpoint through the pinned transport, at the address the run
 * resolved and validated for it, answered through `./token-response.ts`
 * (ACT-126). Its transport failures map onto the same §13.16 codes an
 * `http_request` gets.
 *
 * The form carries `grant_type`, the refresh token for that grant and the
 * scope only when the plan has one. The client authenticates in the form
 * (`post`: `client_id` and `client_secret`) or, for `basic`, as RFC 6749
 * §2.3.1 says: HTTP Basic over the form-urlencoded id and secret, and then
 * neither is in the form.
 */
import { readBodyCapped, type PinnedFetch } from '../../../net/pinned-https.ts';
import { fail, type Result } from '../../../result.ts';
import { transportFailure } from '../http/response.ts';

import { type TokenGrant, tokenOutcome } from './token-response.ts';

import type { ExchangePlan } from './exchange.ts';
import type { ActionError } from '../../errors.ts';

const MAX_RESPONSE_BYTES = 64 * 1024;

export interface TokenRequest {
  readonly plan: ExchangePlan;
  readonly clientSecret: string;
  /**
  The current refresh token; required by the `refresh_token` grant and unused by the other.
  */
  readonly refreshToken: string | undefined;
  readonly address: string;
  readonly signal: AbortSignal;
  readonly version: string;
}

/**
The `application/x-www-form-urlencoded` form of one value (`+` for a space), as RFC 6749 Appendix B has it.
*/
function formEncoded(value: string): string {
  return new URLSearchParams([['v', value]]).toString().slice('v='.length);
}

/**
ACT-125: RFC 6749 §2.3.1's HTTP Basic credentials, each half form-urlencoded before it is joined.
*/
function basicAuthorization(clientId: string, clientSecret: string): string {
  const pair = `${formEncoded(clientId)}:${formEncoded(clientSecret)}`;
  return `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
}

function formBody(request: TokenRequest): Buffer {
  const { plan } = request;
  const form = new URLSearchParams();
  if (plan.clientAuth === 'post') {
    form.set('client_id', plan.clientId);
    form.set('client_secret', request.clientSecret);
  }
  if (plan.scope !== undefined) {
    form.set('scope', plan.scope);
  }
  form.set('grant_type', plan.grant);
  if (request.refreshToken !== undefined) {
    form.set('refresh_token', request.refreshToken);
  }
  return Buffer.from(form.toString(), 'utf8');
}

function headersFor(request: TokenRequest): Readonly<Record<string, string>> {
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
    'user-agent': `vaultgate/${request.version}`,
  };
  const { plan } = request;
  return plan.clientAuth === 'basic'
    ? { ...headers, authorization: basicAuthorization(plan.clientId, request.clientSecret) }
    : headers;
}

export async function requestToken(
  transport: PinnedFetch,
  request: TokenRequest,
): Promise<Result<TokenGrant, ActionError>> {
  try {
    const response = await transport({
      url: request.plan.url,
      address: request.address,
      method: 'POST',
      headers: headersFor(request),
      body: formBody(request),
      signal: request.signal,
    });
    return tokenOutcome(response, await readBodyCapped(response, MAX_RESPONSE_BYTES));
  } catch (error: unknown) {
    return fail(transportFailure(error, request.signal));
  }
}
