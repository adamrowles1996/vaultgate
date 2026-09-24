/**
 * The last steps of ACT-16: the credential fetched through `VaultClient`
 * (ACT-50, ACT-54), the destination resolved once and pinned (ACT-55,
 * ACT-56), the connector run under the policy timeout (ACT-59) and its
 * output scrubbed and capped (ACT-51, ACT-52). Injected buffers are zeroed
 * in `finally` whatever happens.
 */
import { fail, ok, type Result } from '../result.ts';
import { parseFieldSelector } from '../vault/fields.ts';

import { pinEndpoint } from './destination.ts';
import { ActionError } from './errors.ts';
import { createSecretHolder, type SecretHolder } from './secrets.ts';

import type {
  ConnectorOutput,
  PinnedEndpoint,
  RunContext,
  RunSupport,
} from './connectors/connector.ts';
import type { ResolvedCall } from './engine-resolve.ts';
import type { CappedText, InjectedEntry, Scrubber } from './scrub.ts';
import type { Logger } from '../logger.ts';
import type { Lookup } from '../net/ip-ranges.ts';
import type { SecretField, VaultClient } from '../vault/client.ts';

export interface RunDependencies {
  readonly vault: VaultClient;
  readonly lookup: Lookup;
  readonly logger: Logger;
  readonly now: () => number;
  readonly schedule: (callback: () => void, delayMs: number) => () => void;
}

export interface RunOutput {
  /**
  Scrubbed, capped, with `truncated` and `duration_ms` set; what the agent receives.
  */
  readonly result: Readonly<Record<string, unknown>>;
  readonly outputBytes: number;
  readonly outputTruncated: boolean;
}

/**
The secrets of one call: what the mapping named, plus anything the run adds (ACT-82, ACT-83).
*/
export type Credential = SecretHolder;

/**
A fetched value, or the reason it could not be fetched (logged for the operator, never sent to the agent).
*/
type Fetched = { readonly value: string } | { readonly reason: string };

async function usernameOf(vault: VaultClient, itemId: string): Promise<Fetched> {
  const item = await vault.getItem(itemId);
  if (!item.ok) {
    return { reason: item.error.code };
  }
  const username = item.value.login?.username;
  return username == null ? { reason: 'missing_field' } : { value: username };
}

async function secretOf(
  vault: VaultClient,
  itemId: string,
  selector: SecretField,
): Promise<Fetched> {
  const secret = await vault.getSecret(itemId, selector);
  if (!secret.ok) {
    return { reason: secret.error.code };
  }
  return { value: secret.value.kind === 'totp' ? secret.value.code : secret.value.value };
}

/**
 * ACT-54: every failure (locked vault, missing item, missing field, a
 * selector the mapping should not have) is the one `credential_unavailable`;
 * the precise reason goes to the log for the operator, never to the agent.
 * A `username` field feeds the `basic` mode and is not itself injected.
 */
export async function fetchCredential(
  dependencies: Pick<RunDependencies, 'vault' | 'logger'>,
  resolved: ResolvedCall,
): Promise<Result<Credential, ActionError>> {
  const { row, documents, schemas } = resolved.target;
  const unavailable = (field: string, reason: string): Result<never, ActionError> => {
    dependencies.logger.warn({ target: row.name, field, reason }, 'credential unavailable');
    return fail(new ActionError('credential_unavailable'));
  };
  const entries: InjectedEntry[] = [];
  let username: string | undefined;
  for (const field of schemas.credentialFields(documents.credential)) {
    const selector = parseFieldSelector(field.selector);
    if (selector === undefined) {
      return unavailable(field.name, 'invalid_selector');
    }
    const fetched =
      selector.kind === 'username'
        ? await usernameOf(dependencies.vault, row.credential.item_id)
        : await secretOf(dependencies.vault, row.credential.item_id, selector);
    if ('reason' in fetched) {
      return unavailable(field.name, fetched.reason);
    }
    if (field.role === 'username') {
      username = fetched.value;
    } else {
      entries.push({ field: field.name, value: Buffer.from(fetched.value, 'utf8') });
    }
  }
  return ok(
    createSecretHolder(entries, username ?? schemas.basicUsername?.(documents.destination)),
  );
}

/**
ACT-55, ACT-56: every host the destination names, resolved once and validated.
*/
export async function pinDestination(
  lookup: Lookup,
  resolved: ResolvedCall,
): Promise<Result<readonly PinnedEndpoint[], ActionError>> {
  const { row, documents, schemas } = resolved.target;
  const pinned: PinnedEndpoint[] = [];
  for (const endpoint of schemas.endpoints(documents.destination)) {
    const outcome = await pinEndpoint(endpoint, row.internal, lookup);
    if (!outcome.ok) {
      const code =
        outcome.error.problem === 'unresolved' ? 'connection_failed' : 'destination_refused';
      return fail(new ActionError(code, { reason: outcome.error.problem }));
    }
    pinned.push(outcome.value);
  }
  return ok(pinned);
}

/**
 * ACT-52: each captured stream scrubbed and cut at the limit; ACT-51: a stream
 * the connector marked `base64` is scrubbed as bytes and encoded here, after
 * the scrubber has seen it.
 */
function capture(
  output: ConnectorOutput,
  scrub: Scrubber,
  maxBytes: number,
): readonly (readonly [string, CappedText])[] {
  const encoded = new Set<string>(output.base64);
  return Object.entries(output.captured).map(
    ([key, buffer]) =>
      [
        key,
        encoded.has(key) ? scrub.base64(buffer, maxBytes) : scrub.buffer(buffer, maxBytes),
      ] as const,
  );
}

function assemble(
  output: ConnectorOutput,
  scrub: Scrubber,
  maxBytes: number,
  durationMs: number,
): RunOutput {
  const captured = capture(output, scrub, maxBytes);
  const isOutputTruncated =
    output.result['truncated'] === true || captured.some(([, capped]) => capped.truncated);
  // `capture` has already scrubbed every captured stream; only the
  // connector's own result fields still need a pass. Scrubbing the merged
  // object would walk a megabyte of body a second time, on the event loop
  // that also serves OAuth and the operator pages.
  const result = {
    ...scrub.deep(output.result),
    ...Object.fromEntries(captured.map(([key, capped]) => [key, capped.text])),
    truncated: isOutputTruncated,
    duration_ms: durationMs,
  };
  return {
    result,
    outputBytes: output.bytes ?? captured.reduce((total, [, capped]) => total + capped.bytes, 0),
    outputTruncated: isOutputTruncated,
  };
}

const THROWN_MESSAGE_CAP = 1024;

/**
 * A connector that throws instead of answering is a bug in the connector or
 * its library; the call still ends with one code and a scrubbed, capped
 * message rather than an exception escaping to the transport.
 */
async function attempt(
  connector: ResolvedCall['connector'],
  context: RunContext<unknown, unknown, unknown>,
  operation: unknown,
): Promise<Result<ConnectorOutput, ActionError>> {
  try {
    return await connector.run(context, operation);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return fail(
      new ActionError('upstream_error', { message: message.slice(0, THROWN_MESSAGE_CAP) }),
    );
  }
}

/**
What one connector run is given: the resolved call, its secrets, its pinned addresses and the engine's support.
*/
export interface ConnectorCall {
  readonly resolved: ResolvedCall;
  readonly credential: Credential;
  readonly pinned: readonly PinnedEndpoint[];
  readonly support: RunSupport;
}

/**
 * Runs the connector with the injected values and the pinned addresses,
 * under an `AbortSignal` that fires at the policy timeout; a connector that
 * outlives it is abandoned and the call is `timeout` (ACT-59).
 */
export async function runConnector(
  dependencies: Pick<RunDependencies, 'logger' | 'now' | 'schedule'>,
  call: ConnectorCall,
): Promise<Result<RunOutput, ActionError>> {
  const { resolved, credential, pinned, support } = call;
  const { documents } = resolved.target;
  const { now } = dependencies;
  const controller = new AbortController();
  const timedOut = new Promise<Result<never, ActionError>>((resolve) => {
    controller.signal.addEventListener('abort', () => {
      resolve(fail(new ActionError('timeout')));
    });
  });
  const cancel = dependencies.schedule(() => {
    controller.abort();
  }, documents.common.timeout_ms);
  const context: RunContext<unknown, unknown, unknown> = {
    ...documents,
    tool: resolved.tool.name,
    injected: credential.injected,
    support,
    pinned,
    signal: controller.signal,
    outputLimit: {
      maxBytes: documents.common.max_output_bytes,
      // Read when the body is read, so a value the run itself obtained
      // (ACT-82) widens the guard band before the cut (ACT-52).
      get guardBytes() {
        return credential.scrub.guardBytes;
      },
    },
    logger: dependencies.logger,
  };
  const startedAt = now();
  try {
    const output = await Promise.race([
      attempt(resolved.connector, context, resolved.operation),
      timedOut,
    ]);
    return output.ok
      ? ok(
          assemble(
            output.value,
            credential.scrub,
            documents.common.max_output_bytes,
            now() - startedAt,
          ),
        )
      : output;
  } finally {
    cancel();
    credential.injected.dispose();
  }
}
