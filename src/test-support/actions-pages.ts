/**
 * The account pages of the actions layer in-process (ID-22, ACT-5): the
 * identity module and the actions engine over one store, composed through
 * `createApp` exactly as `main.ts` does, with the OAuth layer's consent
 * holders replaced by a list the test controls and a cookie-jar browser that
 * signs the operator in through the real first-run flow.
 */
import { createCodeConnector } from '../actions/connectors/code/index.ts';
import { createActionsPages } from '../actions/pages/index.ts';

import { actionsEnabled } from './actions-config.ts';
import { type ActionsHarness, createActionsHarness, PUBLIC_ADDRESS } from './actions-fixtures.ts';
import { type Browser, createBrowser } from './browser.ts';
import { openTestDatabase } from './database.ts';
import { createFakeGitHub, type FakeGitHub } from './fake-github.ts';
import {
  createHarness as createIdentityHarness,
  csrfOf,
  type Harness as IdentityHarness,
  pageText,
  PASSWORD,
  setUpOperator,
} from './identity-app.ts';
import { createTestApp, TEST_PUBLIC_URL, type TestApp } from './test-app.ts';

import type { FakeSidecar } from './fake-code-sidecar.ts';
import type { InMemoryVaultClient } from './in-memory-vault-client.ts';
import type { CodeControl } from '../actions/connectors/code/control.ts';
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
  /**
  The GitHub the pages list repositories from and check against (ACT-119, ACT-120).
  */
  readonly github: FakeGitHub;
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
  /**
  The vault the pages and the engine read; the fixture vault by default.
  */
  readonly vault?: InMemoryVaultClient;
  /**
  The real `code` connector over these fakes as the engine's runtime, in place of the echo connector.
  */
  readonly code?: { readonly sidecar: FakeSidecar; readonly github: FakeGitHub };
  /**
  What the pages see as `engine.code` in place of the engine's own (ACT-115).
  */
  readonly codeControl?: CodeControl;
  /**
  The GitHub the pages reach; the code connector's, or one that knows no repository.
  */
  readonly github?: FakeGitHub;
}

const CODE_URL = 'unix:/run/vaultgate-code/code.sock';

/**
The engine the pages drive: the echo connector, or the real `code` connector over the fakes.
*/
function pagesEngine(
  database: ReturnType<typeof openTestDatabase>,
  options: PagesHarnessOptions,
): ActionsHarness {
  const { code } = options;
  const kinds = code === undefined ? (['http', 'sql', 'ssh'] as const) : (['code'] as const);
  const runtime =
    code === undefined
      ? undefined
      : createCodeConnector({
          url: CODE_URL,
          userAgent: 'vaultgate/test',
          http: code.sidecar.http,
          fetch: code.github.fetch,
        });
  return createActionsHarness({
    database,
    addresses: options.addresses,
    config: actionsEnabled(kinds, {
      allowAnyCommand: options.allowAnyCommand ?? false,
      ...(code !== undefined && { codeUrl: CODE_URL }),
    }),
    ...(options.vault !== undefined && { vault: options.vault }),
    ...(runtime !== undefined && { runtime }),
  });
}

/**
The GitHub the pages reach (ACT-119, ACT-120): the one asked for, the code connector's, or an empty one.
*/
function pagesGitHub(options: PagesHarnessOptions): FakeGitHub {
  return options.github ?? options.code?.github ?? createFakeGitHub({ repos: [] });
}

export function createPagesHarness(options: PagesHarnessOptions = {}): PagesHarness {
  const database = openTestDatabase();
  const isAnyCommandAllowed = options.allowAnyCommand ?? false;
  const actions = pagesEngine(database, options);
  const github = pagesGitHub(options);
  const code = options.codeControl ?? actions.engine.code;
  const lookup = (host: string) => Promise.resolve(options.addresses?.[host] ?? [PUBLIC_ADDRESS]);
  const clients: ClientChoice[] = [];
  const pages =
    options.enabled === false
      ? undefined
      : createActionsPages({
          targets: actions.engine.targets,
          database,
          vault: actions.vault,
          sensitiveAction: (context) => identity.identity.sensitiveAction(context),
          operatorAction: (context) => identity.identity.operatorAction(context),
          pageHeaders: (context, next) => identity.identity.pageHeaders(context, next),
          github: { fetch: github.fetch, lookup, userAgent: 'vaultgate/test' },
          code,
          listClients: () => clients,
          switches: { allowAnyCommand: isAnyCommandAllowed },
          renderConsole: (session, page) => identity.identity.renderConsole(session, page),
          consoleAccess: (context) => identity.identity.consoleAccess(context),
          now: () => identity.now(),
        });
  const identity = createIdentityHarness({
    database,
    sections:
      pages === undefined
        ? {}
        : { agents: [pages.agentsSection], activity: [pages.activitySection] },
    navigation: pages?.navigation,
    homePath: pages === undefined ? undefined : '/account/actions',
  });
  const app = createTestApp({ identity: identity.identity, actionsPages: pages?.routes });
  return {
    app,
    identity,
    actions,
    clients,
    browser: () => createBrowser(app.app, TEST_PUBLIC_URL),
    github,
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
