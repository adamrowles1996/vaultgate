/**
 * The forms this build can draw, one per connector whose descriptors have
 * landed (ACT-6), each with the common policy fields appended. A connector
 * without a form here is listed on the account page but cannot be created or
 * edited until its milestone.
 */
import { CONNECTOR_KINDS, type ConnectorKind } from '../../config/actions.ts';

import {
  COMMON_POLICY_FIELDS,
  type ConnectorForm,
  type FieldDescriptor,
  type FormSwitches,
} from './descriptors.ts';
import { httpForm } from './http-form.ts';
import { sqlForm } from './sql-form.ts';
import { sshForm } from './ssh-form.ts';

const FORMS: Partial<Readonly<Record<ConnectorKind, ConnectorForm>>> = {
  http: httpForm,
  sql: sqlForm,
  ssh: sshForm,
};

/**
ACT-88: a field the deployment does not allow is not drawn, so it cannot be submitted either.
*/
function isAllowed(field: FieldDescriptor, switches: FormSwitches): boolean {
  return field.allowedBy === undefined || switches[field.allowedBy];
}

/**
The form of a connector this build can edit targets for, with the common policy fields appended.
*/
export function formFor(kind: ConnectorKind, switches: FormSwitches): ConnectorForm | undefined {
  const form = FORMS[kind];
  return form === undefined
    ? undefined
    : {
        kind,
        fields: [...form.fields, ...COMMON_POLICY_FIELDS].filter((field) =>
          isAllowed(field, switches),
        ),
      };
}

/**
The connectors whose targets this build can create and edit.
*/
export function editableConnectors(): readonly ConnectorKind[] {
  return CONNECTOR_KINDS.filter((kind) => FORMS[kind] !== undefined);
}
