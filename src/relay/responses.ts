/**
 * `bw serve`'s response envelope (RELAY-5): `{ success: true, data }` or
 * `{ success: false, message }`. The messages a `bw serve` client branches
 * on are reproduced verbatim (`Not found.`, `More than one result was
 * found.`); the vault's own failures become 503 or 500 so a client retries
 * an unavailable vault instead of treating it as a wrong request.
 */
import type { VaultError } from '../vault/client.ts';

export interface RelayReply {
  readonly status: 200 | 400 | 403 | 404 | 429 | 500 | 503;
  readonly body: Readonly<Record<string, unknown>>;
}

export function success(data: unknown): RelayReply {
  return { status: 200, body: { success: true, data } };
}

export function failure(status: RelayReply['status'], message: string): RelayReply {
  return { status, body: { success: false, message } };
}

export function stringReply(value: string): RelayReply {
  return success({ object: 'string', data: value });
}

export const NOT_FOUND = failure(404, 'Not found.');

export const FORBIDDEN = failure(403, 'Forbidden.');

export const UNKNOWN_ROUTE = failure(404, 'Unknown route.');

export function ambiguous(ids: readonly string[]): RelayReply {
  return failure(
    400,
    'More than one result was found. Try getting a specific object by `id` instead. ' +
      `The following objects were found:\n${ids.join('\n')}`,
  );
}

/**
A vault failure as a reply: unavailable (locked, signing in, restarting) is 503, anything else 500.
*/
export function vaultFailure(error: VaultError): RelayReply {
  return error.code === 'vault_unavailable'
    ? failure(503, 'Vault is unavailable.')
    : failure(500, 'Vault error.');
}
