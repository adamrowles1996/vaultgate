/**
 * The routes of the Computers pages (ACT-5): the list, "Add computer" (the
 * kinds, then a connector's form), a computer's page and its edit page, and
 * the `POST /account/actions/*` writes, every write behind the identity
 * module's injected gate (ID-18 and the ID-15 window) and every change made
 * through the targets service so its ACT-7 event is recorded there. A
 * rejected create or edit answers `400` with the form re-rendered, every
 * problem listed and the submitted values shown again (ACT-6).
 */
import { Hono } from 'hono';

import { CONNECTOR_KINDS } from '../../config/actions.ts';

import { registerCallPages } from './call-routes.ts';
import { computersView } from './computers-view.ts';
import { computersPage } from './computers.ts';
import { createPage, editPage, kindChooserPage } from './form-pages.ts';
import { documentsFromForm, type FormValues } from './form-values.ts';
import { deploymentProblems, formFor } from './forms.ts';
import { isComputerKind, kindOf } from './kinds.ts';
import { CREATE_PATH, NEW_PATH, targetPath } from './paths.ts';
import { formKind, kindChoices, prefilled } from './prefill.ts';
import {
  CONNECTOR_FIELD,
  DESCRIPTION_FIELD,
  INTERNAL_FIELD,
  ITEM_ID_FIELD,
  NAME_FIELD,
} from './target-form.ts';
import { targetPage } from './target-page.ts';
import { registerTargetWrites } from './target-writes.ts';
import {
  type ActionsPagesDependencies,
  fieldProblems,
  signedIn,
  targetPageView,
  targetValues,
  type Viewer,
  viewerOf,
} from './view.ts';

import type { ConnectorForm } from './descriptors.ts';
import type { IdentityContext, IdentityEnvironment } from '../../identity/index.ts';
import type { TargetSummary } from '../targets.ts';

const NOTICES: Readonly<Record<string, string>> = {
  created: 'Computer created.',
  updated: 'Computer saved; its revision has moved on and open confirmations are void.',
  enabled: 'Computer enabled.',
  disabled: 'Computer disabled; agents no longer see it.',
  granted: 'Grant added.',
  'grant-revoked': 'Grant removed and the agent’s sessions on this computer closed.',
  'sessions-closed': 'Every open session on this computer was closed.',
  deleted: 'Computer deleted. Its calls stay in the audit trail.',
};

/**
 * ID-24: the query parameter names one of the notices above and nothing
 * else. A plain index would return an inherited member for `constructor` or
 * `toString`, which the renderer is not typed for and which crashed the page
 * with a 500 that no audit event explained.
 */
function noticeFor(name: string | undefined): string | undefined {
  return name !== undefined && Object.hasOwn(NOTICES, name) ? NOTICES[name] : undefined;
}

function editableForm(
  dependencies: ActionsPagesDependencies,
  kind: string | undefined,
): ConnectorForm | undefined {
  const known = CONNECTOR_KINDS.find((candidate) => candidate === kind);
  return known === undefined ? undefined : formFor(known, dependencies.switches);
}

function text(values: FormValues, name: string): string {
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

async function showComputers(context: IdentityContext, dependencies: ActionsPagesDependencies) {
  const viewer = signedIn(context, dependencies.consoleAccess);
  if (viewer instanceof Response) {
    return viewer;
  }
  const kind = context.req.query('kind');
  const filter = isComputerKind(kind) ? kind : undefined;
  const view = await computersView(dependencies, viewer.operatorId, filter);
  const page = computersPage({ ...view, notice: noticeFor(context.req.query('notice')) });
  return context.html(await dependencies.renderConsole(viewer.session, page));
}

interface CreateRequest {
  readonly form: ConnectorForm;
  readonly values: FormValues;
  readonly problems?: readonly string[];
}

async function renderCreate(
  dependencies: ActionsPagesDependencies,
  viewer: Viewer,
  request: CreateRequest,
): Promise<string> {
  const { form, values } = request;
  const page = createPage({
    csrfToken: viewer.csrfToken,
    isReauthenticated: viewer.isReauthenticated,
    problems: fieldProblems(form, request.problems),
    form,
    values,
    kind: formKind(form, values),
  });
  return dependencies.renderConsole(viewer.session, page);
}

async function showCreate(context: IdentityContext, dependencies: ActionsPagesDependencies) {
  const viewer = signedIn(context, dependencies.consoleAccess);
  if (viewer instanceof Response) {
    return viewer;
  }
  const connector = context.req.query(CONNECTOR_FIELD);
  if (connector === undefined) {
    const page = kindChooserPage(kindChoices());
    return context.html(await dependencies.renderConsole(viewer.session, page));
  }
  const form = editableForm(dependencies, connector);
  if (form === undefined) {
    return context.notFound();
  }
  const values = prefilled(form, context.req.query('kind'));
  return context.html(await renderCreate(dependencies, viewer, { form, values }));
}

async function create(context: IdentityContext, dependencies: ActionsPagesDependencies) {
  const gate = await dependencies.sensitiveAction(context);
  if (gate instanceof Response) {
    return gate;
  }
  const form = editableForm(dependencies, gate.form.get(CONNECTOR_FIELD));
  if (form === undefined) {
    return context.notFound();
  }
  const viewer = viewerOf(gate.session);
  const refused = deploymentProblems(gate.form, dependencies.switches);
  if (refused.length > 0) {
    const request = { form, values: gate.form, problems: refused };
    return context.html(await renderCreate(dependencies, viewer, request), 400);
  }
  const created = await dependencies.targets.create(
    targetInputFromForm(form, gate.form, true),
    gate.operatorId,
  );
  if (created.ok) {
    return context.redirect(`${targetPath(created.value.id)}?notice=created`, 303);
  }
  const request = { form, values: gate.form, problems: created.error.problems };
  return context.html(await renderCreate(dependencies, viewer, request), 400);
}

async function showTarget(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
  id: string,
): Promise<Response> {
  const viewer = signedIn(context, dependencies.consoleAccess);
  if (viewer instanceof Response) {
    return viewer;
  }
  const target = dependencies.targets.get(id);
  if (target === undefined) {
    return context.notFound();
  }
  const notice = noticeFor(context.req.query('notice'));
  const view = await targetPageView(dependencies, target, viewer, { notice });
  return context.html(await dependencies.renderConsole(viewer.session, targetPage(view)));
}

/**
The connector's form and the target as it is now, or the 404 when either is missing.
*/
function editable(
  dependencies: ActionsPagesDependencies,
  id: string,
): { readonly target: TargetSummary; readonly form: ConnectorForm } | undefined {
  const target = dependencies.targets.get(id);
  const form = target === undefined ? undefined : formFor(target.connector, dependencies.switches);
  return target === undefined || form === undefined ? undefined : { target, form };
}

async function renderEdit(
  dependencies: ActionsPagesDependencies,
  viewer: Viewer,
  current: { readonly target: TargetSummary; readonly form: ConnectorForm },
  submitted?: { readonly values: FormValues; readonly problems: readonly string[] },
): Promise<string> {
  const { target, form } = current;
  const page = editPage({
    csrfToken: viewer.csrfToken,
    isReauthenticated: viewer.isReauthenticated,
    problems: fieldProblems(form, submitted?.problems),
    form,
    values: submitted?.values ?? targetValues(form, target),
    kind: kindOf(target),
    targetId: target.id,
    targetName: target.name,
  });
  return dependencies.renderConsole(viewer.session, page);
}

async function showEdit(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
  id: string,
) {
  const viewer = signedIn(context, dependencies.consoleAccess);
  if (viewer instanceof Response) {
    return viewer;
  }
  const current = editable(dependencies, id);
  return current === undefined
    ? context.notFound()
    : context.html(await renderEdit(dependencies, viewer, current));
}

async function update(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
  id: string,
): Promise<Response> {
  const gate = await dependencies.sensitiveAction(context);
  if (gate instanceof Response) {
    return gate;
  }
  const current = editable(dependencies, id);
  if (current === undefined) {
    return context.notFound();
  }
  const viewer = viewerOf(gate.session);
  const refused = deploymentProblems(gate.form, dependencies.switches);
  if (refused.length > 0) {
    const submitted = { values: gate.form, problems: refused };
    return context.html(await renderEdit(dependencies, viewer, current, submitted), 400);
  }
  const updated = await dependencies.targets.update(
    current.target.id,
    targetInputFromForm(current.form, gate.form, false),
    gate.operatorId,
  );
  if (updated.ok) {
    return context.redirect(`${targetPath(current.target.id)}?notice=updated`, 303);
  }
  const submitted = { values: gate.form, problems: updated.error.problems };
  return context.html(await renderEdit(dependencies, viewer, current, submitted), 400);
}

export function createActionsRoutes(
  dependencies: ActionsPagesDependencies,
): Hono<IdentityEnvironment> {
  const app = new Hono<IdentityEnvironment>();
  // ID-19 on every page and every write of this sub-application, whatever
  // order the composition layer mounts it in.
  app.use(`${CREATE_PATH}/*`, dependencies.pageHeaders);
  app.use(CREATE_PATH, dependencies.pageHeaders);
  registerCallPages(app, dependencies);
  app.get(CREATE_PATH, (context) => showComputers(context, dependencies));
  app.get(NEW_PATH, (context) => showCreate(context, dependencies));
  app.post(CREATE_PATH, (context) => create(context, dependencies));
  app.get(`${CREATE_PATH}/:id`, (context) =>
    showTarget(context, dependencies, context.req.param('id')),
  );
  app.get(`${CREATE_PATH}/:id/edit`, (context) =>
    showEdit(context, dependencies, context.req.param('id')),
  );
  app.post(`${CREATE_PATH}/:id`, (context) =>
    update(context, dependencies, context.req.param('id')),
  );
  registerTargetWrites(app, dependencies);
  return app;
}
