/**
 * Checks as you go (ACT-118) as the pages run them: every save-time check of
 * the targets service on what a form holds or on a saved target, and for a
 * code target GitHub's answer about the repository too (ACT-120). The
 * service's own check never reads a secret; the GitHub question is asked
 * here, by the pages, inside the ID-15 window only.
 */
import { githubCheck } from './code-github.ts';
import { savedInput, text } from './form-input.ts';
import { documentsFromForm, type FormValues } from './form-values.ts';
import { ITEM_ID_FIELD } from './target-form.ts';

import type { PageCheck } from './check-report.ts';
import type { ConnectorForm } from './descriptors.ts';
import type { ActionsPagesDependencies, Viewer } from './view.ts';
import type { CheckReport } from '../targets-checks.ts';
import type { TargetSummary } from '../targets.ts';

type Dependencies = Pick<ActionsPagesDependencies, 'github' | 'vault' | 'now'>;

/**
ACT-118, ACT-120: a form's check, with GitHub asked about the repository the form names.
*/
export async function formCheck(
  dependencies: Dependencies,
  viewer: Pick<Viewer, 'isReauthenticated'>,
  submission: { readonly form: ConnectorForm; readonly values: FormValues },
  report: CheckReport,
): Promise<PageCheck> {
  const { form, values } = submission;
  const documents = documentsFromForm(form, values);
  const github = await githubCheck(dependencies, {
    connector: form.kind,
    destination: documents.destination,
    credential: { item_id: text(values, ITEM_ID_FIELD), mapping: documents.credential },
    isReauthenticated: viewer.isReauthenticated,
  });
  return { report, at: dependencies.now(), github };
}

/**
ACT-118, ACT-120: Check now on a saved target, which resolves its hosts and reads its item again.
*/
export async function savedCheck(
  dependencies: Dependencies & Pick<ActionsPagesDependencies, 'targets'>,
  viewer: Pick<Viewer, 'isReauthenticated'>,
  target: TargetSummary,
): Promise<PageCheck> {
  const report = await dependencies.targets.checkChanges(target.connector, savedInput(target));
  const github = await githubCheck(dependencies, {
    connector: target.connector,
    destination: target.destination,
    credential: target.credential,
    isReauthenticated: viewer.isReauthenticated,
  });
  return { report, at: dependencies.now(), github };
}
