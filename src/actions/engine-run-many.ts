/**
 * The run of ACT-16 for a call over several targets (ACT-110): one
 * connector run over every target's context at once, under the smallest of
 * their timeouts and output caps, its output scrubbed with every target's
 * table (ACT-51, ACT-52). Every injected buffer is zeroed at the end
 * whatever happens (ACT-50).
 */
import { fail, ok, type Result } from '../result.ts';

import {
  assemble,
  type ConnectorCall,
  type RunOutput,
  THROWN_MESSAGE_CAP,
  type RunDependencies,
} from './engine-run.ts';
import { ActionError } from './errors.ts';

import type { ConnectorOutput, RunContext } from './connectors/connector.ts';
import type { Scrubber } from './scrub.ts';

function contextsOf(
  dependencies: Pick<RunDependencies, 'logger'>,
  calls: readonly ConnectorCall[],
  shared: { readonly signal: AbortSignal; readonly maxBytes: number; readonly scrub: Scrubber },
): RunContext<unknown, unknown, unknown>[] {
  return calls.map((call) => ({
    ...call.resolved.target.documents,
    tool: call.resolved.tool.name,
    injected: call.credential.injected,
    support: call.support,
    pinned: call.pinned,
    signal: shared.signal,
    outputLimit: {
      maxBytes: shared.maxBytes,
      get guardBytes() {
        return shared.scrub.guardBytes;
      },
    },
    logger: dependencies.logger,
  }));
}

/**
A connector that throws instead of answering still ends the call with one code.
*/
async function attemptMany(
  call: ConnectorCall,
  contexts: readonly RunContext<unknown, unknown, unknown>[],
): Promise<Result<ConnectorOutput, ActionError>> {
  const { connector, operation } = call.resolved;
  try {
    return (
      (await connector.runMany?.(contexts, operation)) ??
      fail(new ActionError('connector_fault', { reason: 'internal', message: 'no runMany' }))
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(
      new ActionError('upstream_error', { message: message.slice(0, THROWN_MESSAGE_CAP) }),
    );
  }
}

export async function runConnectorMany(
  dependencies: Pick<RunDependencies, 'logger' | 'now' | 'schedule'>,
  calls: readonly ConnectorCall[],
  scrub: Scrubber,
): Promise<Result<RunOutput, ActionError>> {
  const common = calls.map((call) => call.resolved.target.documents.common);
  const maxBytes = Math.min(...common.map((policy) => policy.max_output_bytes));
  const controller = new AbortController();
  const timedOut = new Promise<Result<never, ActionError>>((resolve) => {
    controller.signal.addEventListener('abort', () => {
      resolve(fail(new ActionError('timeout')));
    });
  });
  const cancel = dependencies.schedule(
    () => {
      controller.abort();
    },
    Math.min(...common.map((policy) => policy.timeout_ms)),
  );
  const contexts = contextsOf(dependencies, calls, { signal: controller.signal, maxBytes, scrub });
  const startedAt = dependencies.now();
  try {
    const [first] = calls;
    const output =
      first === undefined
        ? fail(new ActionError('connector_fault', { reason: 'internal', message: 'no target' }))
        : await Promise.race([attemptMany(first, contexts), timedOut]);
    return output.ok
      ? ok(assemble(output.value, scrub, maxBytes, dependencies.now() - startedAt))
      : output;
  } finally {
    cancel();
    for (const call of calls) {
      call.credential.injected.dispose();
    }
  }
}
