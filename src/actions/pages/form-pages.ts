/**
 * The pages that create and edit a computer (ACT-2, ACT-5, ACT-6): first the
 * kind of computer to add, then the vault item (`item-picker.ts`), then that
 * connector's form; after a rejected submission, every problem and the
 * submitted values again. Every step after the kind needs the password
 * confirmed within five minutes (ID-15); outside that window a step shows the
 * way to confirm it, which comes back to the same step, and reads nothing
 * from the vault.
 */
import { icon } from '../../identity/pages/icons.ts';
import { type Html, html } from '../../identity/pages/template.ts';
import { pageHead } from '../../identity/pages/ui.ts';

import { checkCard } from './check-report.ts';
import { type ComputerKind, KINDS } from './kinds.ts';
import { CREATE_PATH, NEW_PATH, targetPath } from './paths.ts';
import { type ChosenItem, lockedForm, renderProblems, renderTargetForm } from './target-form.ts';

import type { ConnectorForm } from './descriptors.ts';
import type { CheckReport } from '../targets-checks.ts';
import type { FormValues } from './form-values.ts';
import type { FieldProblems } from './messages.ts';
import type { ConsolePage } from '../../identity/index.ts';

export interface FormPageView {
  readonly csrfToken: string;
  readonly problems: FieldProblems;
  readonly form: ConnectorForm;
  readonly values: FormValues;
  readonly item: ChosenItem;
  /**
  What "Check without saving" found (ACT-118), shown in place of a rejected save's banner.
  */
  readonly check?: { readonly report: CheckReport; readonly at: number };
}

/**
Above the form: what a check found, or why the last save was refused.
*/
function outcome(view: FormPageView): Html {
  return view.check === undefined
    ? renderProblems(view.problems)
    : checkCard(view.check.report, view.check.at);
}

/**
What every step of one create or one edit shares: title, heading, breadcrumb, and its own address.
*/
export interface StepFrame {
  readonly title: string;
  readonly heading: string;
  readonly crumbs: ConsolePage['crumbs'];
  /**
  Where Unlock editing comes back to (ID-15): this step, as it was asked for.
  */
  readonly returnTo: string;
}

export function createFrame(kind: ComputerKind, returnTo: string): StepFrame {
  const { label } = KINDS[kind];
  return {
    title: `Add ${label}`,
    heading: `Add ${label}`,
    crumbs: [
      { label: 'Connections', href: CREATE_PATH },
      { label: 'Add connection', href: NEW_PATH },
      { label },
    ],
    returnTo,
  };
}

export function editFrame(
  target: { readonly id: string; readonly name: string },
  returnTo: string,
): StepFrame {
  return {
    title: `Edit ${target.name}`,
    heading: `Edit ${target.name}`,
    crumbs: [
      { label: 'Connections', href: CREATE_PATH },
      { label: html`<span class="mono">${target.name}</span>`, href: targetPath(target.id) },
      { label: 'Edit' },
    ],
    returnTo,
  };
}

export function stepPage(frame: StepFrame, intro: string, body: Html): ConsolePage {
  return {
    title: frame.title,
    active: 'computers',
    crumbs: frame.crumbs,
    body: html`${pageHead(frame.heading, intro)} ${body}`,
    returnTo: frame.returnTo,
  };
}

/**
ID-15: outside the window a step offers the way to confirm the password and nothing else.
*/
export function lockedPage(frame: StepFrame, what: string): ConsolePage {
  return stepPage(
    frame,
    'Changes to connections need your password, confirmed in the last five minutes.',
    lockedForm(frame.returnTo, what),
  );
}

/**
One kind of computer an operator can add, and the step it opens.
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
    title: 'Add a connection',
    active: 'computers',
    crumbs: [{ label: 'Connections', href: CREATE_PATH }, { label: 'Add connection' }],
    body: html`${pageHead(
        'Add a connection',
        'What are you connecting to? Each connection is one way in: a Windows server that also runs SQL Server is added once for WinRM and once for SQL Server.',
      )}
      <nav class="choices" aria-label="Kinds of connection">
        ${choices.map((option) => choice(option))}
      </nav>`,
    returnTo: NEW_PATH,
  };
}

export function createPage(frame: StepFrame, view: FormPageView): ConsolePage {
  return stepPage(
    frame,
    'Name it for your agents, say where it is and which of the item’s fields sign in, then set what agents may do. Nothing here is a secret: vaultgate stores the item and field names only.',
    html`${outcome(view)}
    ${renderTargetForm({
      action: CREATE_PATH,
      csrfToken: view.csrfToken,
      form: view.form,
      values: view.values,
      problems: view.problems,
      isNew: true,
      submitLabel: 'Create connection',
      item: view.item,
    })}`,
  );
}

export interface EditPageView extends FormPageView {
  readonly targetId: string;
  readonly kind: ComputerKind;
}

export function editPage(frame: StepFrame, view: EditPageView): ConsolePage {
  return stepPage(
    frame,
    `Saving this ${KINDS[view.kind].label} connection moves its revision on, so any confirmation still open for it is void.`,
    html`${outcome(view)}
    ${renderTargetForm({
      action: targetPath(view.targetId),
      csrfToken: view.csrfToken,
      form: view.form,
      values: view.values,
      problems: view.problems,
      isNew: false,
      submitLabel: 'Save changes',
      item: view.item,
    })}`,
  );
}
