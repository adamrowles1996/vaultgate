/**
 * The operator console's frame (ID-19): a sidebar with the sections, the
 * vault's state and the signed-in operator, a top bar with the breadcrumb
 * and the editing lock of ID-15, and the page itself. Which sections exist
 * depends on the layers a deployment runs, so the navigation arrives as data
 * (`ConsoleChrome`, assembled by `console-chrome.ts`); this module only draws.
 */
import { BRAND_MARK, icon, type IconName } from './icons.ts';
import { EMPTY, hidden, type Html, html, when } from './template.ts';

export interface NavChild {
  readonly label: string;
  readonly href: string;
  readonly count: number;
  /**
  The kind of computer the entry lists (`mssql`, `ssh`, …), which picks its colour.
  */
  readonly kind: string;
}

export interface NavBadge {
  readonly text: string;
  readonly title: string;
}

export interface NavItem {
  readonly key: string;
  readonly label: string;
  readonly href: string;
  readonly icon: IconName;
  readonly count?: number | undefined;
  readonly badge?: NavBadge | undefined;
  readonly children?: readonly NavChild[] | undefined;
}

export interface PrimaryAction {
  readonly label: string;
  readonly href: string;
}

export interface Crumb {
  readonly label: string | Html;
  readonly href?: string | undefined;
}

export interface VaultBadge {
  readonly state: 'ready' | 'unavailable' | 'unconfigured';
  readonly label: string;
  readonly detail: string;
}

/**
ID-15 as the top bar shows it: whether sensitive changes are open, and for how many more minutes.
*/
export interface EditLock {
  readonly isUnlocked: boolean;
  readonly minutesLeft: number;
}

export interface ConsoleChrome {
  readonly nav: readonly NavItem[];
  readonly primaryAction: PrimaryAction | undefined;
  /**
  Empty for an account that predates e-mail identification (ID-26).
  */
  readonly operatorEmail: string;
  readonly csrfToken: string;
  readonly lock: EditLock;
  readonly vault: VaultBadge;
  readonly version: string;
}

export interface ConsolePage {
  readonly title: string;
  /**
  The key of the sidebar entry this page belongs to; `account` marks the footer link.
  */
  readonly active: string;
  readonly crumbs: readonly Crumb[];
  readonly body: Html;
  /**
  Where "Unlock editing" comes back to once the password is confirmed: this page's own path.
  */
  readonly returnTo: string;
}

export const UNLOCK_PATH = '/account/unlock';

/**
The page that confirms the password (ID-15) and then returns to `next`.
*/
export function unlockPath(next: string): string {
  return `${UNLOCK_PATH}?next=${encodeURIComponent(next)}`;
}

function currentWhen(isCurrent: boolean): Html {
  return when(isCurrent, () => html`aria-current="page"`);
}

function navChild(child: NavChild): Html {
  return html`<li>
    <a class="nav-sub-item" href="${child.href}"
      ><span class="kind-dot kind-${child.kind}"></span><span>${child.label}</span
      ><span class="nav-count">${child.count}</span></a
    >
  </li>`;
}

function navTrailer(item: NavItem): Html {
  if (item.badge !== undefined) {
    return html`<span class="nav-badge" title="${item.badge.title}"
      >${icon('alert')}${item.badge.text}</span
    >`;
  }
  return item.count === undefined ? EMPTY : html`<span class="nav-count">${item.count}</span>`;
}

function navItem(item: NavItem, active: string): Html {
  const children = item.children ?? [];
  return html`<li>
    <a class="nav-item" href="${item.href}" ${currentWhen(item.key === active)}
      >${icon(item.icon)}<span>${item.label}</span>${navTrailer(item)}</a
    >
    ${when(
      children.length > 0,
      () =>
        html`<ul class="nav-sub">
          ${children.map((child) => navChild(child))}
        </ul>`,
    )}
  </li>`;
}

/**
A pre-release shows its tag (`rc.14`), a release its number; the full version is the tooltip.
*/
export function shortVersion(version: string): string {
  const dash = version.indexOf('-');
  return dash === -1 ? version : version.slice(dash + 1);
}

function initials(email: string): string {
  const letters = email.replaceAll(/[^a-z]/gi, '').slice(0, 2);
  return letters.length === 0 ? '?' : letters.toUpperCase();
}

function sidebarFoot(chrome: ConsoleChrome, active: string): Html {
  const { vault } = chrome;
  const email = chrome.operatorEmail === '' ? 'No e-mail address yet' : chrome.operatorEmail;
  return html`<div class="sidebar-foot">
    <a class="vault-status is-${vault.state}" href="/account/vault"
      ><span class="status-line"><span class="status-dot"></span>${vault.label}</span
      ><span class="status-detail">${vault.detail}</span></a
    >
    <div class="operator">
      <span class="avatar" aria-hidden="true">${initials(chrome.operatorEmail)}</span>
      <span class="operator-text"
        ><span class="operator-email">${email}</span
        ><a href="/account" ${currentWhen(active === 'account')}>Account &amp; security</a></span
      >
      <form method="post" action="/logout">
        ${hidden('csrf', chrome.csrfToken)}
        <button type="submit" class="icon-button" aria-label="Sign out" title="Sign out">
          ${icon('log-out')}
        </button>
      </form>
    </div>
  </div>`;
}

function sidebar(chrome: ConsoleChrome, active: string): Html {
  const action = chrome.primaryAction;
  return html`<aside class="sidebar">
    <div class="brand">
      ${BRAND_MARK}<span class="brand-name">vaultgate</span
      ><span class="version" title="Version ${chrome.version}"
        >${shortVersion(chrome.version)}</span
      >
    </div>
    ${
      action === undefined
        ? EMPTY
        : html`<a class="cta" href="${action.href}">${icon('plus')}${action.label}</a>`
    }
    <nav class="nav" aria-label="Console">
      <ul>
        ${chrome.nav.map((item) => navItem(item, active))}
      </ul>
    </nav>
    ${sidebarFoot(chrome, active)}
  </aside>`;
}

function crumbList(crumbs: readonly Crumb[]): Html {
  const items = crumbs.map((crumb, index) =>
    index === crumbs.length - 1 || crumb.href === undefined
      ? html`<li aria-current="page">${crumb.label}</li>`
      : html`<li><a href="${crumb.href}">${crumb.label}</a></li>`,
  );
  return html`<nav class="crumbs" aria-label="Breadcrumb">
    <ol>
      ${items}
    </ol>
  </nav>`;
}

function lockChip(lock: EditLock, returnTo: string): Html {
  if (lock.isUnlocked) {
    return html`<span
      class="lock-chip is-unlocked"
      title="A password confirmation lasts five minutes"
      >${icon('unlock')}Editing unlocked · ${lock.minutesLeft} min left</span
    >`;
  }
  return html`<a class="lock-chip" href="${unlockPath(returnTo)}"
    >${icon('lock')}Unlock editing</a
  >`;
}

/**
A console page: the sidebar, the top bar and `page.body` in the content column.
*/
export function consoleDocument(chrome: ConsoleChrome, page: ConsolePage): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${page.title} · vaultgate</title>
        <link rel="stylesheet" href="/static/vaultgate.css" />
      </head>
      <body class="console">
        <a class="skip-link" href="#content">Skip to the page</a>
        <div class="shell">
          ${sidebar(chrome, page.active)}
          <div class="main">
            <header class="top-bar">
              ${crumbList(page.crumbs)}
              <div class="top-bar-actions">${lockChip(chrome.lock, page.returnTo)}</div>
            </header>
            <main id="content" class="content">${page.body}</main>
          </div>
        </div>
      </body>
    </html> `.markup;
}
