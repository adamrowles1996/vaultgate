/**
 * The transport under the vault client: one loopback HTTP call, one zod
 * validation, one `Result`. Error mapping follows spec §05.4 and VAULT-14:
 * a message handed back never repeats what `bw serve` said, because that
 * text can name items, files or accounts. Every call is bounded (VAULT-16):
 * a `bw serve` that stops answering yields `vault_unavailable` with a message
 * that says so, never a request that hangs with nothing logged.
 */
import { fail, ok, type Result } from '../result.ts';
import { VaultError, type VaultErrorCode } from '../vault/client.ts';

import { type Clock, sleep, systemClock } from './clock.ts';
import { envelopeSchema } from './types.ts';

import type { z } from 'zod';

export type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>;

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface ApiRequest<T> {
  readonly method: HttpMethod;
  /**
  Path and query, already encoded, e.g. `/object/item/abc`.
  */
  readonly path: string;
  readonly body?: unknown;
  /**
  Applied to the envelope's `data`.
  */
  readonly schema: z.ZodType<T>;
  /**
  Code for a `success: false` that is neither "not found" nor "locked".
  */
  readonly rejectedCode?: VaultErrorCode;
}

/**
The same bound as a one-shot CLI command; a sync of a large vault fits comfortably.
*/
export const CALL_TIMEOUT_MS = 60_000;

/**
 * The message for a call vaultgate itself aborted at `CALL_TIMEOUT_MS`, kept
 * apart from the one for a refused or reset connection so a log line tells a
 * `bw serve` that stalled from one that is gone. The code is the same.
 */
export const TIMED_OUT_MESSAGE = `the vault did not answer within ${CALL_TIMEOUT_MS / 1000} s`;

const NOT_FOUND = /not found/i;
const UNAVAILABLE = /locked|not logged in/i;
const BAD_PASSWORD = /invalid master password/i;

const MESSAGES: Readonly<Record<VaultErrorCode, string>> = {
  vault_unavailable: 'the vault is locked or not reachable',
  not_found: 'no such item, folder or field',
  invalid_item: 'the vault rejected the request',
  vault_protocol_error: 'the vault gave an unexpected response',
};

export function vaultError(code: VaultErrorCode): VaultError {
  return new VaultError(code, MESSAGES[code]);
}

function classifyRejection(message: string, fallback: VaultErrorCode): VaultError {
  if (NOT_FOUND.test(message)) {
    return vaultError('not_found');
  }
  if (BAD_PASSWORD.test(message)) {
    return new VaultError('vault_unavailable', 'the vault rejected the master password');
  }
  return vaultError(UNAVAILABLE.test(message) ? 'vault_unavailable' : fallback);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export class BwServeApi {
  readonly #endpoint: () => string | undefined;
  readonly #fetch: FetchFunction;
  readonly #clock: Clock;

  /**
  `endpoint` yields the current loopback origin, or `undefined` while no `bw serve` runs.
  */
  constructor(endpoint: () => string | undefined, fetchFunction: FetchFunction, clock?: Clock) {
    this.#endpoint = endpoint;
    this.#fetch = fetchFunction;
    this.#clock = clock ?? systemClock;
  }

  /**
  The response body, or `vault_unavailable` when the call failed or outlived `CALL_TIMEOUT_MS`.
  */
  async #send(endpoint: string, request: ApiRequest<unknown>): Promise<Result<string, VaultError>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const controller = new AbortController();
    const init: RequestInit = { method: request.method, headers, signal: controller.signal };
    if (request.body !== undefined) {
      init.body = JSON.stringify(request.body);
      headers['content-type'] = 'application/json';
    }
    const deadline = sleep(this.#clock, CALL_TIMEOUT_MS);
    void deadline.done.then((outcome) => {
      if (outcome === 'elapsed') {
        controller.abort();
      }
    });
    try {
      const response = await this.#fetch(`${endpoint}${request.path}`, init);
      return ok(await response.text());
    } catch {
      return fail(
        controller.signal.aborted
          ? new VaultError('vault_unavailable', TIMED_OUT_MESSAGE)
          : vaultError('vault_unavailable'),
      );
    } finally {
      deadline.cancel();
    }
  }

  async call<T>(request: ApiRequest<T>): Promise<Result<T, VaultError>> {
    const endpoint = this.#endpoint();
    if (endpoint === undefined) {
      return fail(vaultError('vault_unavailable'));
    }
    const body = await this.#send(endpoint, request);
    if (!body.ok) {
      return body;
    }
    const envelope = envelopeSchema.safeParse(parseJson(body.value));
    if (!envelope.success) {
      return fail(vaultError('vault_protocol_error'));
    }
    if (!envelope.data.success) {
      const fallback = request.rejectedCode ?? 'vault_protocol_error';
      return fail(classifyRejection(envelope.data.message ?? '', fallback));
    }
    const data = request.schema.safeParse(envelope.data.data);
    return data.success ? ok(data.data) : fail(vaultError('vault_protocol_error'));
  }
}
