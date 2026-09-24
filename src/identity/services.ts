import type { Bootstrap } from './bootstrap.ts';
import type { Guards } from './guards.ts';
import type { LoginThrottle } from './login-throttle.ts';
import type { NavBadge, NavItem, PrimaryAction } from './pages/console.ts';
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
 * A section another layer adds to one of identity's console pages for the
 * signed-in operator: the actions layer's grants on Agents and its calls on
 * Activity (ACT-5), supplied by the composition layer only when that layer is
 * enabled, so identity never knows it exists.
 */
export type ConsoleSectionRenderer = (session: SessionState) => Html | Promise<Html>;

/**
The console pages identity serves that other layers may add sections to.
*/
export type ConsoleSectionPage = 'agents' | 'activity' | 'vault';

export type ConsoleSections = Readonly<
  Partial<Record<ConsoleSectionPage, readonly ConsoleSectionRenderer[]>>
>;

/**
 * What the composition layer adds to the console's navigation for one
 * operator: the actions layer's Computers entry and its "Add computer"
 * action, and the badge on Activity (ACT-5). Identity's own entries follow.
 */
export interface ConsoleNavigation {
  readonly items: readonly NavItem[];
  readonly primaryAction?: PrimaryAction | undefined;
  readonly activityBadge?: NavBadge | undefined;
}

export type NavigationProvider = (session: SessionState) => ConsoleNavigation;

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
  The sections other layers add to the Agents, Activity and Vault pages (ACT-5); none by default.
  */
  readonly sections: ConsoleSections;
  /**
  The navigation other layers add to the console (ACT-5); nothing by default.
  */
  readonly navigation: NavigationProvider;
  /**
  Where `/` and a sign-in without a destination lead (ID-23): the console's first section.
  */
  readonly homePath: string;
  /**
  The vault backend as the account page sees it (ID-25); supplied by the composition layer.
  */
  readonly vaultConnection: VaultConnection;
}
