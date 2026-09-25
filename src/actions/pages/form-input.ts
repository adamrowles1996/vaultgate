/**
 * What the create and edit forms submit, as the targets service takes it
 * (ACT-1, ACT-6): the connector's form for a submission, the common fields
 * and the connector documents read off the form, and the addresses the
 * steps link to.
 */
import { CONNECTOR_KINDS } from '../../config/actions.ts';

import { documentsFromForm, type FormValues } from './form-values.ts';
import { deploymentProblems, formFor } from './forms.ts';
import { applyChoices } from './repo-source.ts';
import { DESCRIPTION_FIELD, INTERNAL_FIELD, ITEM_ID_FIELD, NAME_FIELD } from './target-form.ts';

import type { ConnectorForm } from './descriptors.ts';
import type { TargetRow } from '../targets-schemas.ts';
import type { ActionsPagesDependencies } from './view.ts';

export function editableForm(
  dependencies: ActionsPagesDependencies,
  kind: string | undefined,
): ConnectorForm | undefined {
  const known = CONNECTOR_KINDS.find((candidate) => candidate === kind);
  return known === undefined ? undefined : formFor(known, dependencies.switches);
}

/**
A submission with what it chose beside its fields copied in, and what a save refuses before the service.
*/
export interface Submitted {
  readonly values: FormValues;
  readonly refused: readonly string[];
}

/**
 * The values a submission stands for (ACT-2's address and ACT-119's
 * repository applied) and every refusal a save gives before the targets
 * service sees it: a field the deployment does not allow (ACT-88), an
 * internal box on a connection that is never internal (ACT-103), and a
 * choice beside a field that contradicts what is typed in it.
 */
export function submitted(
  dependencies: Pick<ActionsPagesDependencies, 'switches'>,
  form: ConnectorForm,
  sent: FormValues,
): Submitted {
  const { values, problems } = applyChoices(form, sent);
  const internal =
    form.network === 'public' && sent.has(INTERNAL_FIELD)
      ? [`${INTERNAL_FIELD}: this connection reaches the internet only; it is never internal`]
      : [];
  return {
    values,
    refused: [...deploymentProblems(sent, dependencies.switches), ...internal, ...problems],
  };
}

export function text(values: FormValues, name: string): string {
  return (values.get(name) ?? '').trim();
}

/**
The service's input from the submitted form: the common fields and the connector documents.
*/
export function targetInputFromForm(
  form: ConnectorForm,
  values: FormValues,
  isNew: boolean,
): unknown {
  const documents = documentsFromForm(form, values);
  const changes = {
    description: text(values, DESCRIPTION_FIELD),
    destination: documents.destination,
    internal: values.get(INTERNAL_FIELD) === 'on',
    credential: { item_id: text(values, ITEM_ID_FIELD), mapping: documents.credential },
    policy: documents.policy,
  };
  return isNew
    ? { ...changes, name: text(values, NAME_FIELD), connector: form.kind, enabled: true }
    : changes;
}

export function withParameters(path: string, parameters: Readonly<Record<string, string>>): string {
  return `${path}?${new URLSearchParams(parameters).toString()}`;
}

/**
A saved target's editable fields as the service takes them, for a check of what is saved (ACT-118).
*/
export function savedInput(target: TargetRow): unknown {
  const { description, destination, internal, credential, policy } = target;
  return { description, destination, internal, credential, policy };
}
