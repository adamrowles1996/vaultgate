import type { AuditSink } from './audit.ts';
import type { Bootstrap } from './bootstrap.ts';
import type { Guards } from './guards.ts';
import type { LoginThrottle } from './login-throttle.ts';
import type { Html } from './pages/template.ts';
import type { ScryptParameters } from './password.ts';
import type { Clock, Delay, RandomSource } from './primitives.ts';
import type { IdentityStores } from './repositories/index.ts';
import type { SecretBox } from './secret-box.ts';
import type { SessionManager, SessionState } from './session-manager.ts';
import type { CookiePolicy } from './sessions.ts';
import type { StateCodec } from './state-cookie.ts';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Renders the account page's "Connected clients" section for the signed-in
 * operator. Supplied by the OAuth layer, which owns consents (OAUTH-30);
 * identity itself knows nothing about clients.
 */
export type ConnectedClientsRenderer = (session: SessionState) => Html;

/**
Everything a route handler needs, assembled once by `createIdentity`.
*/
export interface IdentityServices {
  readonly database: DatabaseSync;
  readonly stores: IdentityStores;
  readonly bootstrap: Bootstrap;
  readonly sessions: SessionManager;
  readonly throttle: LoginThrottle;
  readonly guards: Guards;
  readonly stateCodec: StateCodec;
  readonly totpBox: SecretBox;
  readonly cookiePolicy: CookiePolicy;
  readonly audit: AuditSink;
  readonly random: RandomSource;
  readonly clock: Clock;
  readonly delay: Delay;
  readonly passwordParameters: ScryptParameters;
  readonly absoluteSessionTtlMs: number;
  readonly connectedClients: ConnectedClientsRenderer;
}
