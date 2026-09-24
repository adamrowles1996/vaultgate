/**
 * The pages that create and edit a computer (ACT-2, ACT-5, ACT-6): first the
 * kind of computer to add, then that connector's form; after a rejected
 * submission, every problem and the submitted values again. Saving needs the
 * password confirmed within five minutes (ID-15); until then the form is
 * shown with the way to confirm it in place of the save button.
 */
import { icon } from '../../identity/pages/icons.ts';
import { html } from '../../identity/pages/template.ts';
import { pageHead } from '../../identity/pages/ui.ts';

import { type ComputerKind, KINDS } from './kinds.ts';
import { CREATE_PATH, editPath, NEW_PATH, targetPath } from './paths.ts';
import { lockedForm, renderProblems, renderTargetForm } from './target-form.ts';

import type { ConnectorForm } from './descriptors.ts';
import type { FormValues } from './form-values.ts';
import type { FieldProblems } from './messages.ts';
import type { ConsolePage } from '../../identity/index.ts';

export interface FormPageView {
  readonly csrfToken: string;
  readonly isReauthenticated: boolean;
  readonly problems: FieldProblems;
  readonly form: ConnectorForm;
  readonly values: FormValues;
  readonly kind: ComputerKind;
}

/**
One kind of computer an operator can add, and the form it opens.
*/
export interface KindChoice {
  readonly kind: ComputerKind;
  readonly href: string;
  readonly description: string;
}

function choice(option: KindChoice) {
  const kind = KINDS[option.kind];
  return html`<a class="choice" href="${option.href}"
    ><span class="kind-tile large kind-${option.kind}">${icon(kind.icon)}</span
    ><span class="cell-main"
      ><span class="choice-title">${kind.label}</span
      ><span class="choice-text">${option.description}</span
      ><span class="choice-meta">${kind.tools}</span></span
    ></a
  >`;
}

/**
ACT-5: "Add computer" starts here, with one card per kind this build can create.
*/
export function kindChooserPage(choices: readonly KindChoice[]): ConsolePage {
  return {
    title: 'Add a computer',
    active: 'computers',
    crumbs: [{ label: 'Computers', href: CREATE_PATH }, { label: 'Add computer' }],
    body: html`${pageHead(
        'Add a computer',
        'What are you connecting to? Each computer is one way in: a Windows server that also runs SQL Server is added once for WinRM and once for SQL Server.',
      )}
      <nav class="choices" aria-label="Kinds of computer">
        ${choices.map((option) => choice(option))}
      </nav>`,
    returnTo: NEW_PATH,
  };
}

export function createPage(view: FormPageView): ConsolePage {
  const kind = KINDS[view.kind];
  const returnTo = `${NEW_PATH}?connector=${view.form.kind}`;
  return {
    title: `Add ${kind.label}`,
    active: 'computers',
    crumbs: [
      { label: 'Computers', href: CREATE_PATH },
      { label: 'Add computer', href: NEW_PATH },
      { label: kind.label },
    ],
    body: html`${pageHead(
      `Add ${kind.label}`,
      'Name it for your agents, point it at the vault item that signs in, then set what agents may do. Nothing here is a secret: vaultgate stores the item and field names only.',
    )}
    ${
      view.isReauthenticated
        ? html`${renderProblems(view.problems)}
          ${renderTargetForm({
            action: CREATE_PATH,
            csrfToken: view.csrfToken,
            form: view.form,
            values: view.values,
            problems: view.problems,
            isNew: true,
            submitLabel: 'Create computer',
          })}`
        : lockedForm(returnTo, 'Adding a computer')
    }`,
    returnTo,
  };
}

export interface EditPageView extends FormPageView {
  readonly targetId: string;
  readonly targetName: string;
}

export function editPage(view: EditPageView): ConsolePage {
  const kind = KINDS[view.kind];
  return {
    title: `Edit ${view.targetName}`,
    active: 'computers',
    crumbs: [
      { label: 'Computers', href: CREATE_PATH },
      {
        label: html`<span class="mono">${view.targetName}</span>`,
        href: targetPath(view.targetId),
      },
      { label: 'Edit' },
    ],
    body: html`${pageHead(
      `Edit ${view.targetName}`,
      `A ${kind.label} computer. Saving moves its revision on, so any confirmation still open for it is void.`,
    )}
    ${
      view.isReauthenticated
        ? html`${renderProblems(view.problems)}
          ${renderTargetForm({
            action: targetPath(view.targetId),
            csrfToken: view.csrfToken,
            form: view.form,
            values: view.values,
            problems: view.problems,
            isNew: false,
            submitLabel: 'Save changes',
          })}`
        : lockedForm(editPath(view.targetId), 'Changing a computer')
    }`,
    returnTo: editPath(view.targetId),
  };
}
