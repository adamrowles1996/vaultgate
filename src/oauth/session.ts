/**
 * What the authorize flow needs from the identity layer (ID-21): who is
 * signed in, an opaque per-session key to bind pending requests to, and the
 * synchroniser token for the consent form. The identity module supplies the
 * implementation at composition time; this module never inspects the
 * provider that produced the session.
 */
export interface OperatorSession {
  readonly operatorId: string;
  /**
  Opaque, stable for the life of the session; never the cookie value itself.
  */
  readonly sessionKey: string;
  readonly csrfToken: string;
}

export interface OperatorSessionResolver {
  resolve(request: Request): Promise<OperatorSession | undefined>;
}

export interface CsrfCheck {
  readonly request: Request;
  readonly session: OperatorSession;
  readonly formToken: string | undefined;
}

/**
 * ID-18: same-origin proof plus the per-session synchroniser token.
 */
export interface CsrfGuard {
  isTrusted(check: CsrfCheck): boolean;
}
