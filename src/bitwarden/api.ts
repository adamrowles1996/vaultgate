/**
 * The transport under the vault client: one loopback HTTP call, one zod
 * validation, one `Result`. Error mapping follows spec §05.4 and VAULT-14:
 * a message handed back never repeats what `bw serve` said, because that
 * text can name items, files or accounts.
 */
import { fail, ok, type Result } from '../result.ts';
import { VaultError, type VaultErrorCode } from '../vault/client.ts';

import { envelopeSchema } from './types.ts';

import type { z } from 'zod';

export type FetchFunction = (input: string, init?: RequestInit) => Promise<Response>;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

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

  /**
  `endpoint` yields the current loopback origin, or `undefined` while no `bw serve` runs.
  */
  constructor(endpoint: () => string | undefined, fetchFunction: FetchFunction) {
    this.#endpoint = endpoint;
    this.#fetch = fetchFunction;
  }

  async #send(endpoint: string, request: ApiRequest<unknown>): Promise<string | undefined> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const init: RequestInit = { method: request.method, headers };
    if (request.body !== undefined) {
      init.body = JSON.stringify(request.body);
      headers['content-type'] = 'application/json';
    }
    try {
      const response = await this.#fetch(`${endpoint}${request.path}`, init);
      return await response.text();
    } catch {
      return undefined;
    }
  }

  async call<T>(request: ApiRequest<T>): Promise<Result<T, VaultError>> {
    const endpoint = this.#endpoint();
    if (endpoint === undefined) {
      return fail(vaultError('vault_unavailable'));
    }
    const body = await this.#send(endpoint, request);
    if (body === undefined) {
      return fail(vaultError('vault_unavailable'));
    }
    const envelope = envelopeSchema.safeParse(parseJson(body));
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
