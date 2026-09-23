/**
 * The `http` connector runtime (spec §14.2): the document schemas, the
 * `http_request` tool, the pure policy half, the `graph` credential adapter
 * of §14.3 and `run` over an injected pinned transport (ACT-78).
 * `httpConnector` is what the registry loads on a deployment with
 * `VAULTGATE_ACTIONS_ENABLE_HTTP=true`; contract tests build one with
 * `createHttpConnector` over a fake transport and a manual clock.
 */
import { createPinnedHttpsFetch, type PinnedFetch } from '../../../net/pinned-https.ts';
import { VERSION } from '../../../version.ts';
import { createGraphTokens } from '../graph/adapter.ts';

import { authorize, capabilities, describeOperation } from './authorize.ts';
import { type HttpOperation, httpRequestTool } from './operation.ts';
import { createRun } from './run.ts';
import {
  type HttpCredential,
  type HttpDestination,
  type HttpPolicy,
  httpSchemas,
} from './schemas.ts';

import type { Connector } from '../connector.ts';

export type HttpConnector = Connector<HttpDestination, HttpCredential, HttpPolicy, HttpOperation>;

export interface HttpConnectorDependencies {
  readonly transport: PinnedFetch;
  /**
  Sent as `User-Agent: vaultgate/<version>` (ACT-80).
  */
  readonly version: string;
  /**
  Reads the access-token cache of ACT-82; injected so its expiry is tested without waiting.
  */
  readonly now: () => number;
}

export function createHttpConnector(dependencies: HttpConnectorDependencies): HttpConnector {
  const tokens = createGraphTokens(dependencies);
  return {
    ...httpSchemas,
    tools: [httpRequestTool],
    capabilities,
    authorize,
    describe: describeOperation,
    run: createRun(dependencies.transport, dependencies.version, tokens),
  };
}

export const httpConnector: HttpConnector = createHttpConnector({
  transport: createPinnedHttpsFetch(),
  version: VERSION,
  now: Date.now,
});
