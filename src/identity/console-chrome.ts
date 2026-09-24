/**
 * What the console frame shows around every page for one operator (ID-19):
 * the navigation — whatever the composition layer contributes first (the
 * actions layer's Computers, ACT-5), then identity's own sections — the
 * vault's state (ID-25), the editing lock (ID-15), the operator's address
 * and the version. Identity's pages and, through `renderConsole`, every
 * other layer's pages draw the same frame.
 */
import { VERSION } from '../version.ts';

import {
  consoleDocument,
  type ConsoleChrome,
  type ConsolePage,
  type NavBadge,
  type NavItem,
  type VaultBadge,
} from './pages/console.ts';
import { relativeTime } from './pages/ui.ts';
import { reauthenticationMinutesLeft } from './sessions.ts';

import type { IdentityServices } from './services.ts';
import type { SessionState } from './session-manager.ts';
import type { VaultConnectionStatus } from '../vault/connection.ts';

/**
A page of the console, drawn inside its frame for the session's operator.
*/
export type ConsoleRenderer = (session: SessionState, page: ConsolePage) => Promise<string>;

function identityNav(activityBadge: NavBadge | undefined): readonly NavItem[] {
  return [
    { key: 'agents', label: 'Agents', href: '/account/agents', icon: 'bot' },
    {
      key: 'activity',
      label: 'Activity',
      href: '/account/activity',
      icon: 'activity',
      badge: activityBadge,
    },
    { key: 'vault', label: 'Vault', href: '/account/vault', icon: 'vault' },
  ];
}

/**
ID-25 at a glance: connected or not, serving or not, and when it last synced.
*/
export function vaultBadge(status: VaultConnectionStatus, now: number): VaultBadge {
  if (!status.configured) {
    return {
      state: 'unconfigured',
      label: 'Vault not connected',
      detail: 'Connect it on the Vault page',
    };
  }
  if (!status.ready) {
    return {
      state: 'unavailable',
      label: 'Vault unavailable',
      detail: 'Starting, locked or unreachable',
    };
  }
  const detail =
    status.lastSyncAt === null
      ? 'Not synced since start-up'
      : `Synced ${relativeTime(Date.parse(status.lastSyncAt), now)}`;
  return { state: 'ready', label: 'Vault ready', detail };
}

export async function consoleChrome(
  services: IdentityServices,
  session: SessionState,
): Promise<ConsoleChrome> {
  const now = services.clock();
  const contributed = services.navigation(session);
  const operator = services.stores.operators.findById(session.operatorId);
  const status = await services.vaultConnection.status();
  return {
    nav: [...contributed.items, ...identityNav(contributed.activityBadge)],
    primaryAction: contributed.primaryAction,
    operatorEmail: operator?.email ?? '',
    csrfToken: session.csrfToken,
    lock: {
      isUnlocked: session.isReauthenticated,
      minutesLeft: reauthenticationMinutesLeft(session.reauthenticatedAt, now),
    },
    vault: vaultBadge(status, now),
    version: VERSION,
  };
}

export async function renderConsolePage(
  services: IdentityServices,
  session: SessionState,
  page: ConsolePage,
): Promise<string> {
  return consoleDocument(await consoleChrome(services, session), page);
}

export function createConsoleRenderer(services: IdentityServices): ConsoleRenderer {
  return (session, page) => renderConsolePage(services, session, page);
}
