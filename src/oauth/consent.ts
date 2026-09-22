import { transaction } from '../storage/query.ts';

import { pendingScopes } from './authorize.ts';
import {
  type AuthorizeDeps,
  errorPage,
  isBoundToBrowser,
  livePending,
  rateLimitKey,
  redirectToClient,
  redirectWithError,
  requestIdOf,
} from './authorize-shared.ts';
import { APPROVE, scopeFieldName } from './consent-page.ts';
import { auditPrefix, CREDENTIAL_PREFIX, hashCredential, mintCredential } from './credentials.ts';
import { OAuthError } from './errors.ts';
import { type FormFields, readForm } from './form.ts';

import type { Context } from 'hono';
import type { PendingAuthorizationRecord } from './repositories/pending-authorizations.ts';
import type { OperatorSession } from './session.ts';
import type { Scope } from './scopes.ts';

const MAX_FORM_BYTES = 16 * 1024;

/**
 * OAUTH-19: five minutes.
 */
export const CODE_TTL_MS = 5 * 60 * 1000;

interface Decision {
  readonly pending: PendingAuthorizationRecord;
  readonly session: OperatorSession;
  readonly form: FormFields;
}

function target(pending: PendingAuthorizationRecord): {
  readonly redirectUri: string;
  readonly state: string | undefined;
} {
  return { redirectUri: pending.parameters['redirect_uri'] ?? '', state: pending.parameters['state'] };
}

/**
 * OAUTH-18: the ticked subset of what was requested; `vault:read` arrives
 * as a hidden field because its checkbox is disabled.
 */
function tickedScopes(pending: PendingAuthorizationRecord, form: FormFields): readonly Scope[] {
  return pendingScopes(pending).filter((scope) => form.get(scopeFieldName(scope)) === 'on');
}

function issueCode(deps: AuthorizeDeps, decision: Decision, scopes: readonly Scope[]): string {
  const { pending, session } = decision;
  const clientId = pending.parameters['client_id'] ?? '';
  const at = deps.now();
  const code = mintCredential(CREDENTIAL_PREFIX.authorizationCode, deps.random);
  transaction(deps.repos.db, () => {
    const existing = deps.repos.consents.findActive(session.operatorId, clientId);
    let consentId: string;
    if (existing === undefined) {
      consentId = deps.newId();
      deps.repos.consents.insert({
        id: consentId,
        operatorId: session.operatorId,
        clientId,
        scopes,
        grantedAt: at,
        revokedAt: undefined,
      });
    } else {
      consentId = existing.id;
      deps.repos.consents.updateScopes(consentId, [...new Set([...existing.scopes, ...scopes])]);
    }
    deps.repos.authorizationCodes.insert({
      codeHash: hashCredential(code),
      clientId,
      consentId,
      redirectUri: pending.parameters['redirect_uri'] ?? '',
      codeChallenge: pending.parameters['code_challenge'] ?? '',
      resource: pending.parameters['resource'],
      scopes,
      expiresAt: at + CODE_TTL_MS,
      usedAt: undefined,
    });
  });
  return code;
}

function deny(context: Context, deps: AuthorizeDeps, decision: Decision): Response {
  deps.audit.record({
    category: 'oauth',
    action: 'consent_denied',
    outcome: 'success',
    operatorId: decision.session.operatorId,
    clientId: decision.pending.parameters['client_id'] ?? '',
    requestId: requestIdOf(context),
    ip: deps.clientIp(context.req.raw),
  });
  return redirectWithError(
    context,
    deps,
    target(decision.pending),
    new OAuthError('access_denied', 'the operator denied the request'),
  );
}

function approve(context: Context, deps: AuthorizeDeps, decision: Decision): Response {
  const scopes = tickedScopes(decision.pending, decision.form);
  if (scopes.length === 0) {
    return deny(context, deps, decision);
  }
  const code = issueCode(deps, decision, scopes);
  deps.audit.record({
    category: 'oauth',
    action: 'consent_granted',
    outcome: 'success',
    operatorId: decision.session.operatorId,
    clientId: decision.pending.parameters['client_id'] ?? '',
    tokenPrefix: auditPrefix(code),
    requestId: requestIdOf(context),
    ip: deps.clientIp(context.req.raw),
    details: { scopes },
  });
  const { redirectUri, state } = target(decision.pending);
  return redirectToClient(context, deps, redirectUri, { code, state });
}

async function readDecision(
  context: Context,
  deps: AuthorizeDeps,
): Promise<Decision | { readonly error: OAuthError; readonly status: 400 | 403 }> {
  const form = await readForm(context.req.raw, MAX_FORM_BYTES);
  if (!form.ok) {
    return { error: form.error, status: 400 };
  }
  const pending = livePending(deps, form.value.get('request_id') ?? '');
  if (pending === undefined) {
    return {
      error: new OAuthError('invalid_request', 'this authorization request has expired'),
      status: 400,
    };
  }
  const session = await deps.sessions.resolve(context.req.raw);
  if (session === undefined) {
    return { error: new OAuthError('access_denied', 'sign in to continue'), status: 403 };
  }
  const trusted =
    deps.csrf.isTrusted({
      request: context.req.raw,
      session,
      formToken: form.value.get('csrf_token'),
    }) && isBoundToBrowser(context, deps, session, pending);
  return trusted
    ? { pending, session, form: form.value }
    : { error: new OAuthError('access_denied', 'the consent form could not be verified'), status: 403 };
}

/**
 * `POST /oauth/authorize` (OAUTH-18…20): the consent decision, CSRF-guarded,
 * bound to the browser that started the request, single use.
 */
export function createConsentDecisionHandler(
  deps: AuthorizeDeps,
): (context: Context) => Promise<Response> {
  return async (context) => {
    const decision = await readDecision(context, deps);
    if ('error' in decision) {
      return errorPage(context, decision.error, decision.status);
    }
    const limit = deps.rateLimiter.take(rateLimitKey(context, deps, decision.session));
    if (!limit.allowed) {
      context.header('Retry-After', String(limit.retryAfterSeconds));
      return errorPage(
        context,
        new OAuthError('temporarily_unavailable', 'too many authorization requests; retry later'),
        429,
      );
    }
    deps.repos.pendingAuthorizations.delete(decision.pending.id);
    return decision.form.get('decision') === APPROVE
      ? approve(context, deps, decision)
      : deny(context, deps, decision);
  };
}
