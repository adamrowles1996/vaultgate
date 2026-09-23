import type { Bootstrap } from './bootstrap.ts';
import type { Guards } from './guards.ts';
import type { LoginThrottle } from './login-throttle.ts';
import type { Html } from './pages/template.ts';
import type { ScryptParameters } from './password.ts';
import type { Clock, Delay, RandomSource } from './primitives.ts';
import type { IdentityStores } from './repositories/index.ts';
import type { SessionManager, SessionState } from './session-manager.ts';
import type { CookiePolicy } from './sessions.ts';
import type { StateCodec } from './state-cookie.ts';
import type { AuditSink } from '../audit/event.ts';
import type { SecretBox } from '../crypto/secret-box.ts';
import type { VaultConnection } from '../vault/connection.ts';
import type { DatabaseSync } from 'node:sqlite';

/**
 * Renders the account page's "Connected clients" section for the signed-in
 * operator. Supplied by the OAuth layer, which owns consents (OAUTH-30);
 * identity itself knows nothing about clients.
 */
export type ConnectedClientsRenderer = (session: SessionState) => Html;

/**
 * Renders a further section of the account page for the signed-in operator:
 * the actions layer's targets (ACT-5), supplied by the composition layer only
 * when that layer is enabled, so identity never knows it exists.
 */
export type AccountSectionRenderer = (session: SessionState) => Html;

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
  /**
  The account page's extra sections (ACT-5), in order; none by default.
  */
  readonly accountSections: readonly AccountSectionRenderer[];
  /**
  The vault backend as the account page sees it (ID-25); supplied by the composition layer.
  */
  readonly vaultConnection: VaultConnection;
}
