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
import { fieldName } from './form-values.ts';
import { httpForm } from './http-form.ts';
import { sqlForm } from './sql-form.ts';
import { sshForm } from './ssh-form.ts';
import { winrmForm } from './winrm-form.ts';

const FORMS: Partial<Readonly<Record<ConnectorKind, ConnectorForm>>> = {
  http: httpForm,
  sql: sqlForm,
  ssh: sshForm,
  winrm: winrmForm,
};

/**
ACT-88: a field the deployment does not allow is not drawn.
*/
function isAllowed(field: FieldDescriptor, switches: FormSwitches): boolean {
  return field.allowedBy === undefined || switches[field.allowedBy];
}

/**
The switch each gated field needs, by the name a submission would carry.
*/
type DeploymentSwitch = NonNullable<FieldDescriptor['allowedBy']>;

function gatedField(field: FieldDescriptor): readonly [string, DeploymentSwitch][] {
  return field.allowedBy === undefined ? [] : [[fieldName(field), field.allowedBy]];
}

const GATED_FIELDS: Readonly<Record<string, DeploymentSwitch>> = Object.fromEntries(
  Object.values(FORMS).flatMap((form) => form.fields.flatMap((field) => gatedField(field))),
);

const SWITCH_VARIABLES: Readonly<Record<DeploymentSwitch, string>> = {
  allowAnyCommand: 'VAULTGATE_ACTIONS_ALLOW_ANY_COMMAND',
};

/**
 * ACT-88: a submission that names a field this deployment does not allow is
 * refused and told why. The form does not draw such a field, so an ordinary
 * browser never sends one; dropping it silently would leave an operator who
 * sent it believing it had been honoured, and would make the service's own
 * refusal unreachable on the only path that writes a target.
 */
export function deploymentProblems(
  values: { get(name: string): string | undefined },
  switches: FormSwitches,
): readonly string[] {
  return Object.entries(GATED_FIELDS)
    .filter(([name, allowedBy]) => !switches[allowedBy] && values.get(name) !== undefined)
    .map(
      ([name, allowedBy]) => `${name}: ${SWITCH_VARIABLES[allowedBy]} is off on this deployment`,
    );
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
