/**
Request paths and response shaping shared by the vault client's read operations.
*/
import type { StatusTemplate } from './types.ts';
import type { SearchQuery, VaultStatus } from '../vault/client.ts';

export const DEFAULT_SERVER_URL = 'https://vault.bitwarden.com';

/**
`a***@example.com`: enough to recognise the account, not enough to address it.
*/
export function maskEmail(email: string | null | undefined): string | null {
  if (email == null || email.length === 0) {
    return null;
  }
  const at = email.indexOf('@');
  const local = at === -1 ? email : email.slice(0, at);
  const domain = at === -1 ? '' : email.slice(at);
  return `${local.slice(0, 1)}***${domain}`;
}

export function toVaultStatus(template: StatusTemplate, fallbackServerUrl: string): VaultStatus {
  return {
    serverUrl: template.serverUrl ?? fallbackServerUrl,
    userEmailMasked: maskEmail(template.userEmail),
    state: template.status,
    lastSyncAt: template.lastSync ?? null,
  };
}

export function unavailableStatus(serverUrl: string): VaultStatus {
  return { serverUrl, userEmailMasked: null, state: 'unavailable', lastSyncAt: null };
}

export function itemPath(id: string): string {
  return `/object/item/${encodeURIComponent(id)}`;
}

export function fieldPath(field: 'password' | 'notes' | 'totp', id: string): string {
  return `/object/${field}/${encodeURIComponent(id)}`;
}

/**
`GET /list/object/items` with only the filters the query sets; `trash=true` lists the bin instead.
*/
export function searchPath(query: SearchQuery, isTrash: boolean): string {
  const parameters = new URLSearchParams();
  const optional: Record<string, string | undefined> = {
    search: query.text,
    folderid: query.folderId,
    collectionid: query.collectionId,
    url: query.url,
  };
  for (const [name, value] of Object.entries(optional)) {
    if (value !== undefined) {
      parameters.set(name, value);
    }
  }
  if (isTrash) {
    parameters.set('trash', 'true');
  }
  const encoded = parameters.toString();
  return encoded.length === 0 ? '/list/object/items' : `/list/object/items?${encoded}`;
}

export function generatePath(options: Record<string, string | number | boolean>): string {
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(options)) {
    parameters.set(name, String(value));
  }
  return `/generate?${parameters.toString()}`;
}
