import { isSameOriginRequest, isValidCsrfToken } from './csrf.ts';

import type { ClientAddressResolver, Form, IdentityContext } from './context.ts';
import type { ClientInfo } from './session-manager.ts';
import type { AuditSink } from '../audit/event.ts';

export interface GuardDependencies {
  readonly publicUrl: string;
  readonly trustProxy: boolean;
  readonly clientAddress: ClientAddressResolver;
  readonly audit: AuditSink;
}

export interface Guards {
  /**
  Proxy-aware client address and user agent (OPS-6).
  */
  clientInfo(context: IdentityContext): ClientInfo;
  /**
  A `403` with an audit event (ID-18).
  */
  deny(context: IdentityContext, reason: string): Response;
  /**
  Origin and synchroniser-token checks for a state-changing browser request (ID-18).
  */
  stateChange(
    context: IdentityContext,
    form: Form,
    expectedCsrfToken: string,
  ): Response | undefined;
}

export function createGuards(dependencies: GuardDependencies): Guards {
  const { publicUrl, trustProxy, clientAddress, audit } = dependencies;
  const clientInfo = (context: IdentityContext): ClientInfo => {
    const forwarded = trustProxy ? context.req.header('x-forwarded-for') : undefined;
    const ip = forwarded?.split(',', 1)[0]?.trim() || clientAddress(context);
    return { ip, userAgent: context.req.header('user-agent') };
  };
  const deny = (context: IdentityContext, reason: string): Response => {
    const details = { reason, path: context.req.path };
    audit.record({
      category: 'identity',
      action: 'request.denied',
      outcome: 'denied',
      ip: clientInfo(context).ip,
      requestId: context.get('requestId'),
      details,
    });
    return context.text('Forbidden', 403);
  };
  return {
    clientInfo,
    deny,
    stateChange: (context, form, expectedCsrfToken) => {
      if (!isSameOriginRequest(context.req.raw.headers, publicUrl)) {
        return deny(context, 'cross-origin request');
      }
      return isValidCsrfToken(form.get('csrf'), expectedCsrfToken)
        ? undefined
        : deny(context, 'missing or stale synchroniser token');
    },
  };
}
