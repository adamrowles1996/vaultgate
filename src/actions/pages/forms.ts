/**
 * The forms this build can draw, one per connector whose descriptors have
 * landed (ACT-6), each with the common policy fields appended. A connector
 * without a form here is listed on the account page but cannot be created or
 * edited until its milestone.
 */
import { CONNECTOR_KINDS, type ConnectorKind } from '../../config/actions.ts';

import { COMMON_POLICY_FIELDS, type ConnectorForm } from './descriptors.ts';
import { httpForm } from './http-form.ts';
import { sqlForm } from './sql-form.ts';

const FORMS: Partial<Readonly<Record<ConnectorKind, ConnectorForm>>> = {
  http: httpForm,
  sql: sqlForm,
};

/**
The form of a connector this build can edit targets for, with the common policy fields appended.
*/
export function formFor(kind: ConnectorKind): ConnectorForm | undefined {
  const form = FORMS[kind];
  return form === undefined
    ? undefined
    : { kind, fields: [...form.fields, ...COMMON_POLICY_FIELDS] };
}

/**
The connectors whose targets this build can create and edit.
*/
export function editableConnectors(): readonly ConnectorKind[] {
  return CONNECTOR_KINDS.filter((kind) => FORMS[kind] !== undefined);
}
