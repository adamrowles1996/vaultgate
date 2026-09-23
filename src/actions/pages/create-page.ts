/**
 * The page that creates a target of one connector (ACT-2): the form, or the
 * note that the password must be confirmed first (ID-15); after a rejected
 * submission, every problem and the submitted values (ACT-6).
 */
import { document, type Html, html, when } from '../../identity/pages/template.ts';

import { renderProblems, renderTargetForm } from './target-form.ts';

import type { ConnectorForm } from './descriptors.ts';
import type { FormValues } from './form-values.ts';

export const CREATE_PATH = '/account/actions';

export interface CreatePageView {
  readonly csrfToken: string;
  readonly isReauthenticated: boolean;
  readonly problems: readonly string[];
  readonly form: ConnectorForm;
  readonly values: FormValues;
}

function createForm(view: CreatePageView): Html {
  return html`${renderProblems(view.problems)}
  ${renderTargetForm({
    action: CREATE_PATH,
    csrfToken: view.csrfToken,
    form: view.form,
    values: view.values,
    isNew: true,
    submitLabel: 'Create target',
  })}`;
}

export function renderCreatePage(view: CreatePageView): string {
  return document(
    `New ${view.form.kind} target`,
    html`<h2>New <code>${view.form.kind}</code> target</h2>
      <p><a href="/account#actions">Back to the account page</a></p>
      ${when(
        !view.isReauthenticated,
        () =>
          html`<p>
            To create a target, first
            <a href="/account#sensitive-actions">confirm your password</a> under Sensitive actions.
          </p>`,
      )}
      ${when(view.isReauthenticated, () => createForm(view))}`,
  );
}
