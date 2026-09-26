/**
 * The `code` connector's runtime (spec 14.8, ADR 0008): Semble code search
 * over GitHub repositories through the sidecar. Loaded only when
 * `VAULTGATE_ACTIONS_ENABLE_CODE` is on (ACT-73). It is the one connector
 * that keeps state between calls, so the engine attaches its services once:
 * builds on save and on Rebuild index, deletion with the target, the health
 * check and reconciliation whenever the sidecar is found reachable (ACT-109,
 * ACT-115).
 */
import { createLocalHttp, type LocalHttp } from '../../../net/local-http.ts';
import { createPinnedHttpsFetch, type PinnedFetch } from '../../../net/pinned-https.ts';
import { fail } from '../../../result.ts';
import { ActionError } from '../../errors.ts';

import { authorizeCode, authorizeCodeMany, describeCode } from './authorize.ts';
import { createBuilds, keyOf } from './builds.ts';
import { type CodeControl, createControl } from './control.ts';
import { createIndexes } from './indexes.ts';
import { type CodeDocuments, extractionFingerprint, resetFingerprint } from './keys.ts';
import { watchReachability } from './reachability.ts';
import { runCode } from './run.ts';
import { codeSchemas, normaliseContent } from './schemas.ts';
import { SIDECAR_PROTOCOL } from './sidecar-schemas.ts';
import { createSidecarClient, type SidecarClient } from './sidecar.ts';
import { type CodeState, createCodeState } from './state.ts';
import { background, withDeadline } from './timing.ts';
import { CODE_TOOLS, type CodeOperation } from './tools.ts';

import type { Connector, ConnectorControl, ConnectorServices, RunContext } from '../connector.ts';
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

type Context = RunContext<CodeDestination, CodeCredential, CodePolicy>;

const HEALTH_TIMEOUT_MS = 5000;

/**
What one attached connector holds between calls.
*/
interface Attached {
  readonly control: CodeControl;
  readonly run: (
    contexts: readonly [Context, ...Context[]],
    operation: CodeOperation,
  ) => ReturnType<typeof runCode>;
  readonly isAvailable: () => boolean;
}

interface Parts {
  readonly sidecar: SidecarClient;
  readonly services: ConnectorServices;
  readonly state: CodeState;
}

/**
 * ACT-115: the sidecar's versions logged, then ACT-109's reconciliation;
 * false for a sidecar whose protocol this build cannot speak, which turns
 * the code tools off. A sidecar that does not answer is not incompatible:
 * calls answer `index_unavailable` until it does, and then it is checked.
 */
async function checkSidecar(parts: Parts, control: CodeControl): Promise<boolean | undefined> {
  const { services } = parts;
  const health = await withDeadline(services, HEALTH_TIMEOUT_MS, (signal) =>
    parts.sidecar.health(signal),
  );
  if (!health.ok) {
    services.logger.warn({ reason: health.error.code }, 'code sidecar not answering yet');
    return undefined;
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

function resetOf(documents: unknown): string | undefined {
  return documents === undefined ? undefined : resetFingerprint(documents as CodeDocuments);
}

/**
ACT-108: a save builds an enabled target; a revision that changed the snapshots' inputs deletes them first.
*/
function saved(parts: Parts, control: CodeControl, targetId: string, previous: unknown): void {
  const stored = parts.services.targets().find((target) => target.id === targetId);
  const isReset = previous !== undefined && resetOf(previous) !== resetOf(stored?.documents);
  if (stored?.enabled === true) {
    background(parts.services, 'a build on save', () => control.refresh(targetId, 'save', isReset));
  } else if (isReset) {
    background(parts.services, 'deleting the snapshots of a changed target', () =>
      control.forgetTarget(targetId),
    );
  }
}

/**
The single-flight health check of ACT-115, run at start-up and whenever the sidecar is found again.
*/
function createCheck(
  parts: Parts,
  control: CodeControl,
): {
  readonly check: () => Promise<void>;
  readonly isAvailable: () => boolean;
} {
  let isAvailable = true;
  let checking: Promise<void> | undefined;
  return {
    check: () => {
      checking ??= (async () => {
        try {
          isAvailable = (await checkSidecar(parts, control)) ?? isAvailable;
        } finally {
          checking = undefined;
        }
      })();
      return checking;
    },
    isAvailable: () => isAvailable,
  };
}

function attach(
  options: CodeConnectorOptions,
  raw: SidecarClient,
  fetch: PinnedFetch,
  services: ConnectorServices,
): { readonly attached: Attached; readonly control: ConnectorControl } {
  const watched = watchReachability(raw);
  const sidecar = watched.client;
  const state = createCodeState({
    services,
    fingerprintOf: (request) => extractionFingerprint(request.documents),
    keyOf,
  });
  const parts: Parts = { sidecar, services, state };
  const builds = createBuilds({
    sidecar,
    fetch,
    services,
    userAgent: options.userAgent,
    finished: (request, outcome, ended) => {
      state.finished(request, outcome, ended);
    },
  });
  const dependencies = { sidecar, fetch, services, userAgent: options.userAgent, builds, state };
  const control = createControl(dependencies);
  const indexes = createIndexes(dependencies);
  const health = createCheck(parts, control);
  watched.onReachable(() => {
    background(services, 'the sidecar check', health.check);
  });
  background(services, 'the sidecar check', health.check);
  return {
    attached: {
      control,
      run: (contexts, operation) =>
        runCode({ sidecar, indexes, clock: services }, contexts, operation),
      isAvailable: health.isAvailable,
    },
    control: {
      saved(targetId, previous) {
        saved(parts, control, targetId, previous);
      },
      removed(targetId) {
        background(services, 'deleting the snapshots of a deleted target', () =>
          control.forgetTarget(targetId),
        );
      },
      available: health.isAvailable,
    },
  };
}

export function createCodeConnector(options: CodeConnectorOptions): CodeConnector {
  const raw = createSidecarClient(options.http ?? createLocalHttp(options.url));
  const fetch = options.fetch ?? createPinnedHttpsFetch();
  let attached: Attached | undefined;
  const runMany: CodeConnector['runMany'] = async (contexts, operation) => {
    const [first, ...rest] = contexts;
    if (attached?.isAvailable() !== true) {
      return fail(new ActionError('index_unavailable'));
    }
    return first === undefined
      ? fail(new ActionError('connector_fault', { reason: 'internal', message: 'no repo' }))
      : attached.run([first, ...rest], operation);
  };
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
    authorizeMany: authorizeCodeMany,
    describe: describeCode,
    run: async (context, operation) => runMany([context], operation),
    runMany,
    attach(services): ConnectorControl {
      const made = attach(options, raw, fetch, services);
      attached = made.attached;
      return made.control;
    },
    control: () => attached?.control,
  };
}
