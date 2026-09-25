/**
 * The `code` connector's runtime (spec 14.8, ADR 0008): Semble code search
 * over GitHub repositories through the sidecar. Loaded only when
 * `VAULTGATE_ACTIONS_ENABLE_CODE` is on (ACT-73). It is the one connector
 * that keeps state between calls, so the engine attaches its services once:
 * builds on save and on Rebuild index, deletion with the target, start-up
 * reconciliation and the health check of ACT-115.
 */
import { createLocalHttp, type LocalHttp } from '../../../net/local-http.ts';
import { createPinnedHttpsFetch, type PinnedFetch } from '../../../net/pinned-https.ts';
import { fail } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import { authorizeCode, describeCode } from './authorize.ts';
import { createBuilds, keyOf } from './builds.ts';
import { type CodeControl, createControl } from './control.ts';
import { createIndexes } from './indexes.ts';
import { type CodeDocuments, extractionFingerprint, resetFingerprint } from './keys.ts';
import { runCode } from './run.ts';
import { codeSchemas, normaliseContent } from './schemas.ts';
import { SIDECAR_PROTOCOL } from './sidecar-schemas.ts';
import { createSidecarClient, type SidecarClient } from './sidecar.ts';
import { type CodeState, createCodeState } from './state.ts';
import { CODE_TOOLS, type CodeOperation } from './tools.ts';

import type { Connector, ConnectorControl, ConnectorServices } from '../connector.ts';
import type { CodeCredential, CodeDestination, CodePolicy } from './schemas.ts';

export interface CodeConnectorOptions {
  /**
  `VAULTGATE_ACTIONS_CODE_URL`.
  */
  readonly url: string;
  readonly userAgent: string;
  readonly http?: LocalHttp;
  readonly fetch?: PinnedFetch;
}

export type CodeConnector = Connector<
  CodeDestination,
  CodeCredential,
  CodePolicy,
  CodeOperation
> & {
  /**
  The target page's view of the connector (ACT-115), once the engine has attached it.
  */
  readonly control: () => CodeControl | undefined;
};

const HEALTH_TIMEOUT_MS = 5000;

/**
What one attached connector holds between calls.
*/
interface Attached {
  readonly control: CodeControl;
  readonly state: CodeState;
  readonly run: (
    contexts: Parameters<typeof runCode>[1],
    operation: CodeOperation,
  ) => ReturnType<typeof runCode>;
  isAvailable: boolean;
}

/**
 * ACT-115: the sidecar's versions logged at start-up, then ACT-109's
 * reconciliation; false for a sidecar whose protocol this build cannot
 * speak, which turns the code tools off. A sidecar that does not answer yet
 * is not incompatible: calls answer `index_unavailable` until it does.
 */
async function isCompatible(
  sidecar: SidecarClient,
  services: ConnectorServices,
  control: CodeControl,
): Promise<boolean> {
  const health = await sidecar.health(AbortSignal.timeout(HEALTH_TIMEOUT_MS));
  if (!health.ok) {
    services.logger.warn({ reason: health.error.code }, 'code sidecar not answering yet');
    return true;
  }
  const { protocol, semble, model, model_revision: revision } = health.value;
  if (protocol !== SIDECAR_PROTOCOL) {
    services.logger.error(
      { protocol, expected: SIDECAR_PROTOCOL },
      'code sidecar protocol is incompatible; the code tools are off',
    );
    return false;
  }
  services.logger.info({ protocol, semble, model, revision }, 'code sidecar ready');
  await control.reconcile();
  return true;
}

function attach(
  options: CodeConnectorOptions,
  sidecar: SidecarClient,
  fetch: PinnedFetch,
  services: ConnectorServices,
): Attached {
  const state = createCodeState({
    services,
    fingerprintOf: (request) => extractionFingerprint(request.documents),
    keyOf,
  });
  const builds = createBuilds({
    sidecar,
    fetch,
    services,
    userAgent: options.userAgent,
    finished: (request, outcome, durationMs) => {
      state.finished(request, outcome, durationMs);
    },
  });
  const dependencies = { sidecar, fetch, services, userAgent: options.userAgent, builds, state };
  const indexes = createIndexes(dependencies);
  return {
    control: createControl(dependencies),
    state,
    run: (contexts, operation) =>
      runCode({ sidecar, indexes, now: services.now }, contexts, operation),
    isAvailable: true,
  };
}

/**
ACT-108: a revision that changes what the snapshots were built from deletes them first.
*/
function isReset(services: ConnectorServices, targetId: string, previous: unknown): boolean {
  const current = services.targets().find((target) => target.id === targetId)?.documents;
  return (
    previous !== undefined &&
    current !== undefined &&
    resetFingerprint(previous as CodeDocuments) !== resetFingerprint(current as CodeDocuments)
  );
}

export function createCodeConnector(options: CodeConnectorOptions): CodeConnector {
  const sidecar = createSidecarClient(options.http ?? createLocalHttp(options.url));
  const fetch = options.fetch ?? createPinnedHttpsFetch();
  let attached: Attached | undefined;
  const runMany: CodeConnector['runMany'] = async (contexts, operation) =>
    attached?.isAvailable === true
      ? attached.run(contexts, operation)
      : fail(new ActionError('index_unavailable'));
  return {
    ...codeSchemas,
    tools: CODE_TOOLS,
    capabilities: (destination, policy) => ({
      operations: [{ operation: 'read', scope: 'actions:code' }],
      code: {
        repository: destination.repository,
        ref: destination.ref,
        content: normaliseContent(policy.content),
        read: policy.allow_read,
      },
    }),
    authorize: authorizeCode,
    describe: describeCode,
    run: async (context, operation) => runMany([context], operation),
    runMany,
    attach(services): ConnectorControl {
      const current = attach(options, sidecar, fetch, services);
      attached = current;
      void (async () => {
        current.isAvailable = await isCompatible(sidecar, services, current.control);
      })();
      return {
        saved(targetId, previous) {
          void current.control.refresh(targetId, 'save', isReset(services, targetId, previous));
        },
        removed(targetId) {
          void current.control.forgetTarget(targetId);
        },
        available: () => current.isAvailable,
      };
    },
    control: () => attached?.control,
  };
}
