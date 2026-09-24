/**
 * Identity's other console pages (ID-19): Agents (the clients connected over
 * OAuth, OAUTH-30), Activity (the audit export, OPS-5) and the page that
 * confirms the password before a change (ID-15). The sections other layers
 * add (ACT-5) arrive already drawn; these pages only place them.
 */
import { reauthenticateForm } from './account.ts';
import { auditExportSection } from './audit-export.ts';
import { errorBanner, type Html, html, noticeBanner } from './template.ts';
import { cardHead, pageHead } from './ui.ts';

import type { ConsolePage } from './console.ts';

export interface SectionsView {
  readonly csrfToken: string;
  readonly isReauthenticated: boolean;
  readonly notice: string | undefined;
  readonly error: string | undefined;
  /**
  The sections other layers add to this page, in order (ACT-5).
  */
  readonly sections: readonly Html[];
}

export interface AgentsView extends SectionsView {
  /**
  The connected clients as the OAuth layer draws them (OAUTH-30).
  */
  readonly connectedClients: Html;
}

export function agentsPage(view: AgentsView): ConsolePage {
  const body = html`${pageHead(
      'Agents',
      'Apps connected to vaultgate over OAuth. Each uses only the scopes it asked for when it connected, and only the computers you grant it.',
    )}
    ${errorBanner(view.error)} ${noticeBanner(view.notice)}
    <section class="card" id="connected-clients">
      ${cardHead('Connected', 'Disconnecting an agent ends its tokens and removes every grant it holds.')}
      ${view.connectedClients}
    </section>
    ${view.sections}`;
  return {
    title: 'Agents',
    active: 'agents',
    crumbs: [{ label: 'Agents' }],
    body,
    returnTo: '/account/agents',
  };
}

export function activityPage(view: SectionsView): ConsolePage {
  const body = html`${pageHead(
    'Activity',
    'What agents did through vaultgate, and the audit log to export for a date range.',
  )}
  ${errorBanner(view.error)} ${noticeBanner(view.notice)} ${view.sections}
  ${auditExportSection({ csrfToken: view.csrfToken, isReauthenticated: view.isReauthenticated })}`;
  return {
    title: 'Activity',
    active: 'activity',
    crumbs: [{ label: 'Activity' }],
    body,
    returnTo: '/account/activity',
  };
}

export interface UnlockView {
  readonly csrfToken: string;
  /**
  Where the operator returns once the password is confirmed; already checked to be a path here.
  */
  readonly next: string;
  readonly error: string | undefined;
}

/**
ID-15: confirm the password, then carry on where "Unlock editing" was pressed.
*/
export function unlockPage(view: UnlockView): ConsolePage {
  const body = html`${pageHead(
      'Unlock editing',
      'Confirm your password to make changes for the next five minutes. Nothing else changes.',
    )}
    ${errorBanner(view.error)}
    <section class="card narrow">
      ${cardHead('Confirm your password')} ${reauthenticateForm(view.csrfToken, view.next)}
    </section>`;
  return {
    title: 'Unlock editing',
    active: '',
    crumbs: [{ label: 'Unlock editing' }],
    body,
    returnTo: view.next,
  };
}
