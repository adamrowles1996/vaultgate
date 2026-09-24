/**
 * The kinds of computer the console groups targets into (ACT-5): one per
 * connector, except that `sql` splits by engine and `http` sets its Microsoft
 * Graph targets apart, because an operator thinks "SQL Server" or "Graph",
 * not "sql" or "http". The kind is read off the stored documents; a document
 * that does not say (an invalid row, ACT-1) falls back to the connector's
 * first kind.
 */
import { z } from 'zod';

import type { IconName } from '../../identity/pages/icons.ts';
import type { TargetSummary } from '../targets.ts';

export type ComputerKind =
  'mssql' | 'postgres' | 'winrm' | 'ssh' | 'http' | 'graph' | 'browser' | 'code';

export interface KindDescription {
  readonly label: string;
  /**
  The name of the group of these on the Computers page and in the sidebar.
  */
  readonly plural: string;
  readonly icon: IconName;
  /**
  The tools an agent reaches this kind of computer through (spec §13.6).
  */
  readonly tools: string;
}

export const KINDS: Readonly<Record<ComputerKind, KindDescription>> = {
  mssql: {
    label: 'SQL Server',
    plural: 'SQL Server',
    icon: 'database',
    tools: 'sql_query · sql_execute',
  },
  postgres: {
    label: 'PostgreSQL',
    plural: 'PostgreSQL',
    icon: 'database',
    tools: 'sql_query · sql_execute',
  },
  winrm: {
    label: 'Windows (WinRM)',
    plural: 'Windows · WinRM',
    icon: 'monitor',
    tools: 'winrm_run',
  },
  ssh: { label: 'Linux or Unix (SSH)', plural: 'Linux · SSH', icon: 'terminal', tools: 'ssh_run' },
  http: { label: 'HTTP API', plural: 'HTTP APIs', icon: 'globe', tools: 'http_request' },
  graph: {
    label: 'Microsoft Graph',
    plural: 'Microsoft Graph',
    icon: 'graph',
    tools: 'http_request',
  },
  browser: { label: 'Browser', plural: 'Browsers', icon: 'globe', tools: 'browser_*' },
  code: { label: 'Code', plural: 'Code', icon: 'file', tools: 'code_search' },
};

/**
The order kinds are listed in: databases, then command lines, then APIs.
*/
export const KIND_ORDER: readonly ComputerKind[] = [
  'mssql',
  'postgres',
  'winrm',
  'ssh',
  'http',
  'graph',
  'browser',
  'code',
];

const KIND_NAMES: ReadonlySet<string> = new Set(KIND_ORDER);

export function isComputerKind(text: string | undefined): text is ComputerKind {
  return text !== undefined && KIND_NAMES.has(text);
}

/**
The documents say which engine and which credential mode; anything else reads as the default kind.
*/
const mssqlDestination = z.object({ engine: z.literal('mssql') });
const graphMapping = z.object({ mode: z.literal('graph') });

export function kindOf(
  target: Pick<TargetSummary, 'connector' | 'destination' | 'credential'>,
): ComputerKind {
  switch (target.connector) {
    case 'sql': {
      return mssqlDestination.safeParse(target.destination).success ? 'mssql' : 'postgres';
    }
    case 'http': {
      return graphMapping.safeParse(target.credential.mapping).success ? 'graph' : 'http';
    }
    default: {
      return target.connector;
    }
  }
}
