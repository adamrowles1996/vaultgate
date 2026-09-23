/**
 * The account pages of the actions layer in-process (ID-22, ACT-5): the
 * identity module and the actions engine over one store, composed through
 * `createApp` exactly as `main.ts` does, with the OAuth layer's consent
 * holders replaced by a list the test controls and a cookie-jar browser that
 * signs the operator in through the real first-run flow.
 */
import { createActionsPages } from '../actions/pages/index.ts';

import { actionsEnabled } from './actions-config.ts';
import { type ActionsHarness, createActionsHarness } from './actions-fixtures.ts';
import { type Browser, createBrowser } from './browser.ts';
import { openTestDatabase } from './database.ts';
import {
  createHarness as createIdentityHarness,
  csrfOf,
  type Harness as IdentityHarness,
  pageText,
  PASSWORD,
  setUpOperator,
} from './identity-app.ts';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from './test-app.ts';

import type { ClientChoice } from '../actions/pages/target-page.ts';

export interface PagesHarness {
  readonly app: TestApp;
  readonly identity: IdentityHarness;
  readonly actions: ActionsHarness;
  /**
  The clients holding a consent, as the injected lister reports them; edit freely.
  */
  readonly clients: ClientChoice[];
  /**
  A cookie-jar browser over the composed application.
  */
  readonly browser: () => Browser;
}

export interface PagesHarnessOptions {
  /**
  `false` composes the application with the layer off: no section, no routes (ACT-5).
  */
  readonly enabled?: boolean;
  /**
  DNS answers per host name for the ACT-3 check; anything else resolves to one public address.
  */
  readonly addresses?: Readonly<Record<string, readonly string[]>>;
  /**
  ACT-88: `VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND`, which the `ssh` form's unrestricted box needs.
  */
  readonly allowAnyCommand?: boolean;
}

export function createPagesHarness(options: PagesHarnessOptions = {}): PagesHarness {
  const database = openTestDatabase();
  const isAnyCommandAllowed = options.allowAnyCommand ?? false;
  const actions = createActionsHarness({
    database,
    addresses: options.addresses,
    config: actionsEnabled(['http', 'sql', 'ssh'], { allowAnyCommand: isAnyCommandAllowed }),
  });
  const clients: ClientChoice[] = [];
  const pages =
    options.enabled === false
      ? undefined
      : createActionsPages({
          targets: actions.engine.targets,
          database,
          vault: actions.vault,
          sensitiveAction: (context) => identity.identity.sensitiveAction(context),
          listClients: () => clients,
          switches: { allowAnyCommand: isAnyCommandAllowed },
        });
  const identity = createIdentityHarness({
    database,
    accountSections: pages === undefined ? [] : [pages.section],
  });
  const app = createTestApp({ identity: identity.identity, actionsPages: pages?.routes });
  return {
    app,
    identity,
    actions,
    clients,
    browser: () => createBrowser(app.app, TEST_PUBLIC_URL),
  };
}

export interface Operator {
  readonly browser: Browser;
  readonly csrf: string;
}

/**
The operator set up and signed in; `isConfirmed` adds the ID-15 password check.
*/
export async function signedInOperator(
  harness: PagesHarness,
  isConfirmed = true,
): Promise<Operator> {
  const setup = await setUpOperator(harness.identity);
  const browser = harness.browser();
  for (const [name, value] of setup.browser.cookies) {
    browser.cookies.set(name, value);
  }
  const csrf = csrfOf(await pageText(browser, '/account'));
  if (isConfirmed) {
    await browser.submit('/account/reauthenticate', { csrf, password: PASSWORD });
  }
  return { browser, csrf };
}
