/**
 * "Add computer" (ACT-5): the kinds this build can create, each opening its
 * connector's form with what the kind implies already filled in — the
 * engine and its usual port for SQL Server or PostgreSQL, the `graph`
 * credential mode and Graph's base URL for Microsoft Graph. The operator can
 * still change every value before saving; nothing is saved here.
 */
import { editableConnectors } from './forms.ts';
import { type ComputerKind, isComputerKind, KIND_ORDER } from './kinds.ts';
import { NEW_PATH } from './paths.ts';
import { createValues } from './view.ts';

import type { ConnectorForm } from './descriptors.ts';
import type { KindChoice } from './form-pages.ts';
import type { FormValues } from './form-values.ts';
import type { ConnectorKind } from '../../config/actions.ts';

const DESCRIPTIONS: Readonly<Record<ComputerKind, string>> = {
  mssql: 'Query a SQL Server database. Writes only if you allow them, each confirmed by a person.',
  postgres: 'Query PostgreSQL inside a read-only transaction, with the same write rules.',
  winrm: 'Run allow-listed PowerShell or cmd commands on a Windows host over WS-Management.',
  ssh: 'Run allow-listed commands, with the host key pinned and no shell in between.',
  http: 'Call a REST API. vaultgate adds the bearer, basic, header or query credential.',
  graph: 'Call Microsoft Graph with a token vaultgate obtains from Entra ID itself.',
  browser: 'Drive a signed-in browser confined to the origins you allow.',
  code: 'Search a repository at a pinned commit, read-only.',
};

const KINDS_OF: Readonly<Record<ConnectorKind, readonly ComputerKind[]>> = {
  sql: ['mssql', 'postgres'],
  winrm: ['winrm'],
  ssh: ['ssh'],
  http: ['http', 'graph'],
  browser: ['browser'],
};

/**
What each kind fills in on its connector's form, by field name.
*/
const PRESETS: Readonly<Partial<Record<ComputerKind, Readonly<Record<string, string>>>>> = {
  mssql: { 'destination.engine': 'mssql', 'destination.port': '1433' },
  postgres: { 'destination.engine': 'postgres', 'destination.port': '5432' },
  graph: {
    'credential.mode': 'graph',
    'destination.base_url': 'https://graph.microsoft.com/v1.0',
  },
};

/**
The kinds in the Computers page's order: databases, then command lines, then APIs.
*/
export function kindChoices(): readonly KindChoice[] {
  return editableConnectors()
    .flatMap((connector) =>
      KINDS_OF[connector].map((kind) => ({
        kind,
        href: `${NEW_PATH}?connector=${connector}&kind=${kind}`,
        description: DESCRIPTIONS[kind],
      })),
    )
    .toSorted((left, right) => KIND_ORDER.indexOf(left.kind) - KIND_ORDER.indexOf(right.kind));
}

/**
A new computer's form values: the defaults, then what the chosen kind implies.
*/
export function prefilled(form: ConnectorForm, kind: string | undefined): FormValues {
  const values = new Map(createValues(form));
  const preset = isComputerKind(kind) ? PRESETS[kind] : undefined;
  const entries = Object.entries(preset ?? {});
  for (const [name, value] of entries) {
    values.set(name, value);
  }
  return values;
}

/**
The kind a form describes, as the Computers page will file it once saved.
*/
export function formKind(form: ConnectorForm, values: FormValues): ComputerKind {
  switch (form.kind) {
    case 'sql': {
      return values.get('destination.engine') === 'mssql' ? 'mssql' : 'postgres';
    }
    case 'http': {
      return values.get('credential.mode') === 'graph' ? 'graph' : 'http';
    }
    default: {
      return form.kind;
    }
  }
}
