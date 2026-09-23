import { transaction } from '../storage/query.ts';

import {
  type AuthorizeDependencies,
  errorPage,
  isBoundToBrowser,
  livePending,
  rateLimitKey,
  redirectToClient,
  redirectWithError,
  type LivePending,
} from './authorize-shared.ts';
import { pendingScopes } from './authorize.ts';
import { APPROVE, scopeFieldName } from './consent-page.ts';
import { auditPrefix, CREDENTIAL_PREFIX, hashCredential, mintCredential } from './credentials.ts';
import { OAuthError } from './errors.ts';
import { type FormFields, readForm, requireField } from './form.ts';

import type { OAuthContext, OAuthHandler } from './request-context.ts';
import type { SessionState } from '../identity/session-manager.ts';
import type { Scope } from '../scopes/registry.ts';

const MAX_FORM_BYTES = 16 * 1024;

/**
 * OAUTH-19: five minutes.
 */
const CODE_TTL_MS = 5 * 60 * 1000;

interface Decision {
  readonly pending: LivePending;
  readonly session: SessionState;
  readonly form: FormFields;
}

function target(pending: LivePending): {
  readonly redirectUri: string;
  readonly state: string | undefined;
} {
  return { redirectUri: pending.parameters.redirect_uri, state: pending.parameters.state };
}

/**
 * OAUTH-18: the ticked subset of what was requested; `vault:read` arrives
 * as a hidden field because its checkbox is disabled.
 */
function tickedScopes(pending: LivePending, form: FormFields): readonly Scope[] {
  return pendingScopes(pending).filter((scope) => form.get(scopeFieldName(scope)) === 'on');
}

function issueCode(
  dependencies: AuthorizeDependencies,
  decision: Decision,
  scopes: readonly Scope[],
): string {
  const { pending, session } = decision;
  const clientId = pending.parameters.client_id;
  const at = dependencies.now();
  const code = mintCredential(CREDENTIAL_PREFIX.authorizationCode, dependencies.random);
  transaction(dependencies.repos.db, () => {
    const existing = dependencies.repos.consents.findActive(session.operatorId, clientId);
    let consentId: string;
    if (existing === undefined) {
      consentId = dependencies.newId();
      dependencies.repos.consents.insert({
        id: consentId,
        operatorId: session.operatorId,
        clientId,
        scopes,
        grantedAt: at,
        revokedAt: undefined,
      });
    } else {
      consentId = existing.id;
      dependencies.repos.consents.updateScopes(consentId, [
        ...new Set([...existing.scopes, ...scopes]),
      ]);
    }
    dependencies.repos.authorizationCodes.insert({
      codeHash: hashCredential(code),
      clientId,
      consentId,
      redirectUri: pending.parameters.redirect_uri,
      codeChallenge: pending.parameters.code_challenge,
      resource: pending.parameters.resource,
      scopes,
      expiresAt: at + CODE_TTL_MS,
      usedAt: undefined,
    });
  });
  return code;
}

function deny(
  context: OAuthContext,
  dependencies: AuthorizeDependencies,
  decision: Decision,
): Response {
  dependencies.audit.record({
    category: 'oauth',
    action: 'consent_denied',
    outcome: 'ok',
    operatorId: decision.session.operatorId,
    clientId: decision.pending.parameters.client_id,
    requestId: context.get('requestId'),
    ip: dependencies.clientIp(context),
  });
  return redirectWithError(
    context,
    dependencies,
    target(decision.pending),
    new OAuthError('access_denied', 'the operator denied the request'),
  );
}

function approve(
  context: OAuthContext,
  dependencies: AuthorizeDependencies,
  decision: Decision,
): Response {
  const scopes = tickedScopes(decision.pending, decision.form);
  if (scopes.length === 0) {
    return deny(context, dependencies, decision);
  }
  const code = issueCode(dependencies, decision, scopes);
  dependencies.audit.record({
    category: 'oauth',
    action: 'consent_granted',
    outcome: 'ok',
    operatorId: decision.session.operatorId,
    clientId: decision.pending.parameters.client_id,
    tokenPrefix: auditPrefix(code),
    requestId: context.get('requestId'),
    ip: dependencies.clientIp(context),
    details: { scopes },
  });
  const { redirectUri, state } = target(decision.pending);
  return redirectToClient(context, dependencies, redirectUri, { code, state });
}

/**
 * ID-18 through the identity guards, then the browser binding (OAUTH-17).
 */
async function readDecision(
  context: OAuthContext,
  dependencies: AuthorizeDependencies,
): Promise<Decision | Response> {
  const form = await readForm(context.req.raw, MAX_FORM_BYTES);
  if (!form.ok) {
    return errorPage(context, form.error, 400);
  }
  const session = context.get('session');
  if (session === undefined) {
    return dependencies.guards.deny(context, 'no session');
  }
  const denied = dependencies.guards.stateChange(context, form.value, session.csrfToken);
  if (denied !== undefined) {
    return denied;
  }
  const requestId = requireField(form.value, 'request_id');
  const pending = requestId.ok ? livePending(dependencies, requestId.value) : undefined;
  if (pending === undefined) {
    return errorPage(
      context,
      new OAuthError('invalid_request', 'this authorization request has expired'),
      400,
    );
  }
  return isBoundToBrowser(context, dependencies, session, pending)
    ? { pending, session, form: form.value }
    : errorPage(
        context,
        new OAuthError('access_denied', 'this authorization request belongs to another browser'),
        403,
      );
}

/**
 * `POST /oauth/authorize` (OAUTH-18…20): the consent decision, CSRF-guarded,
 * bound to the browser that started the request, single use.
 */
export function createConsentDecisionHandler(dependencies: AuthorizeDependencies): OAuthHandler {
  return async (context) => {
    const decision = await readDecision(context, dependencies);
    if (decision instanceof Response) {
      return decision;
    }
    const limit = dependencies.rateLimiter.take(
      rateLimitKey(context, dependencies, decision.session),
    );
    if (!limit.allowed) {
      context.header('Retry-After', String(limit.retryAfterSeconds));
      return errorPage(
        context,
        new OAuthError('temporarily_unavailable', 'too many authorization requests; retry later'),
        429,
      );
    }
    dependencies.repos.pendingAuthorizations.delete(decision.pending.id);
    return decision.form.get('decision') === APPROVE
      ? approve(context, dependencies, decision)
      : deny(context, dependencies, decision);
  };
}
