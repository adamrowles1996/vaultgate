import { fail, ok, type Result } from '../../result.ts';
import { CREDENTIAL_PREFIX } from '../credentials.ts';
import { validateRedirectUri } from '../redirect-uri.ts';

import type { PreregisteredClient } from '../../config/primitives.ts';
import type { ClientRecord } from '../repositories/clients.ts';

export class PreregisteredClientsError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid VAULTGATE_OAUTH_CLIENTS:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'PreregisteredClientsError';
    this.issues = issues;
  }
}

function isHttpsUrl(text: string): boolean {
  try {
    return new URL(text).protocol === 'https:';
  } catch {
    return false;
  }
}

function clientIssues(client: PreregisteredClient, seen: Set<string>): string[] {
  const issues: string[] = [];
  const label = `client "${client.clientId}"`;
  if (seen.has(client.clientId)) {
    issues.push(`${label} is listed twice`);
  }
  seen.add(client.clientId);
  if (isHttpsUrl(client.clientId)) {
    issues.push(`${label}: an https URL client_id is reserved for CIMD`);
  }
  if (client.clientId.startsWith(CREDENTIAL_PREFIX.clientId)) {
    issues.push(
      `${label}: the ${CREDENTIAL_PREFIX.clientId} prefix is reserved for dynamic clients`,
    );
  }
  for (const uri of client.redirectUris) {
    const checked = validateRedirectUri(uri);
    if (!checked.ok) {
      issues.push(`${label}: ${checked.error.message}`);
    }
  }
  return issues;
}

export interface PreregisteredClientOptions {
  readonly now: number;
  readonly newId: () => string;
}

/**
 * OAUTH-12: validated once at start-up; any problem is fatal. The result is
 * persisted to `oauth_clients` so consents and tokens can reference it.
 */
export function validatePreregisteredClients(
  clients: readonly PreregisteredClient[],
  options: PreregisteredClientOptions,
): Result<readonly ClientRecord[], PreregisteredClientsError> {
  const seen = new Set<string>();
  const issues = clients.flatMap((client) => clientIssues(client, seen));
  if (issues.length > 0) {
    return fail(new PreregisteredClientsError(issues));
  }
  return ok(
    clients.map((client) => ({
      id: options.newId(),
      clientId: client.clientId,
      mode: 'preregistered',
      clientName: client.clientName,
      redirectUris: client.redirectUris,
      metadata: {},
      createdAt: options.now,
      revokedAt: undefined,
    })),
  );
}
