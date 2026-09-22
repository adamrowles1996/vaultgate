import { isConstantTimeEqual } from './credentials.ts';

import type { CsrfCheck, CsrfGuard } from './session.ts';

function isSameOrigin(request: Request, publicOrigin: string): boolean {
  const origin = request.headers.get('origin');
  return origin === null
    ? request.headers.get('sec-fetch-site') === 'same-origin'
    : origin === publicOrigin;
}

/**
 * The default ID-18 guard: `Origin` (or `Sec-Fetch-Site: same-origin`) must
 * match the public origin and the form must carry the session's token.
 */
export function createCsrfGuard(publicUrl: string): CsrfGuard {
  const publicOrigin = new URL(publicUrl).origin;
  return {
    isTrusted({ request, session, formToken }: CsrfCheck): boolean {
      return (
        isSameOrigin(request, publicOrigin) &&
        formToken !== undefined &&
        isConstantTimeEqual(formToken, session.csrfToken)
      );
    },
  };
}
