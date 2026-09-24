/**
 * The routes of the Actions pages (ACT-5): two pages and the
 * `POST /account/actions/*` writes, every write behind the identity
 * module's injected gate (ID-18 and the ID-15 window) and every change made
 * through the targets service so its ACT-7 event is recorded there. A
 * rejected create or edit answers `400` with the page re-rendered, every
 * problem listed and the submitted values shown again (ACT-6).
 */
import { Hono } from 'hono';

import { CONNECTOR_KINDS } from '../../config/actions.ts';

import { registerCallPages } from './call-routes.ts';
import { renderCreatePage } from './create-page.ts';
import { documentsFromForm, type FormValues } from './form-values.ts';
import { deploymentProblems, formFor } from './forms.ts';
import { CREATE_PATH, targetPath } from './paths.ts';
import {
  CONNECTOR_FIELD,
  DESCRIPTION_FIELD,
  INTERNAL_FIELD,
  ITEM_ID_FIELD,
  NAME_FIELD,
} from './target-form.ts';
import { renderTargetPage } from './target-page.ts';
import { registerTargetWrites } from './target-writes.ts';
import {
  type ActionsPagesDependencies,
  createValues,
  fieldProblems,
  signedIn,
  targetPageView,
  viewerOf,
} from './view.ts';

import type { ConnectorForm } from './descriptors.ts';
import type { IdentityContext, IdentityEnvironment } from '../../identity/index.ts';
import type { TargetSummary } from '../targets.ts';

const NOTICES: Readonly<Record<string, string>> = {
  created: 'Target created.',
  updated: 'Target saved; its revision has moved on and open confirmations are void.',
  enabled: 'Target enabled.',
  disabled: 'Target disabled; agents no longer see it.',
  granted: 'Grant added.',
  'grant-revoked': 'Grant removed and the client’s sessions on this target closed.',
  'sessions-closed': 'Every open session on this target was closed.',
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

function showCreate(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
): Response | Promise<Response> {
  const viewer = signedIn(context);
  if (viewer instanceof Response) {
    return viewer;
  }
  const form = editableForm(dependencies, context.req.query(CONNECTOR_FIELD));
  if (form === undefined) {
    return context.notFound();
  }
  return context.html(
    renderCreatePage({
      ...viewer,
      problems: fieldProblems(form, undefined),
      form,
      values: createValues(form),
    }),
  );
}

async function create(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
): Promise<Response> {
  const gate = await dependencies.sensitiveAction(context);
  if (gate instanceof Response) {
    return gate;
  }
  const form = editableForm(dependencies, gate.form.get(CONNECTOR_FIELD));
  if (form === undefined) {
    return context.notFound();
  }
  const refused = deploymentProblems(gate.form, dependencies.switches);
  if (refused.length > 0) {
    const denied = {
      ...viewerOf(gate.session),
      problems: fieldProblems(form, refused),
      form,
      values: gate.form,
    };
    return context.html(renderCreatePage(denied), 400);
  }
  const created = await dependencies.targets.create(
    targetInputFromForm(form, gate.form, true),
    gate.operatorId,
  );
  if (created.ok) {
    return context.redirect(`${targetPath(created.value.id)}?notice=created`, 303);
  }
  const view = {
    ...viewerOf(gate.session),
    problems: fieldProblems(form, created.error.problems),
    form,
    values: gate.form,
  };
  return context.html(renderCreatePage(view), 400);
}

async function showTarget(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
  id: string,
): Promise<Response> {
  const viewer = signedIn(context);
  if (viewer instanceof Response) {
    return viewer;
  }
  const target = dependencies.targets.get(id);
  if (target === undefined) {
    return context.notFound();
  }
  const notice = noticeFor(context.req.query('notice'));
  const view = await targetPageView(dependencies, target, viewer, { notice });
  return context.html(renderTargetPage(view));
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
  const { target, form } = current;
  const refused = deploymentProblems(gate.form, dependencies.switches);
  if (refused.length > 0) {
    const denied = { problems: refused, values: gate.form };
    const page = await targetPageView(dependencies, target, viewerOf(gate.session), denied);
    return context.html(renderTargetPage(page), 400);
  }
  const updated = await dependencies.targets.update(
    target.id,
    targetInputFromForm(form, gate.form, false),
    gate.operatorId,
  );
  if (updated.ok) {
    return context.redirect(`${targetPath(target.id)}?notice=updated`, 303);
  }
  const extras = { problems: updated.error.problems, values: gate.form };
  const view = await targetPageView(dependencies, target, viewerOf(gate.session), extras);
  return context.html(renderTargetPage(view), 400);
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
  app.get(`${CREATE_PATH}/new`, (context) => showCreate(context, dependencies));
  app.post(CREATE_PATH, (context) => create(context, dependencies));
  app.get(`${CREATE_PATH}/:id`, (context) =>
    showTarget(context, dependencies, context.req.param('id')),
  );
  app.post(`${CREATE_PATH}/:id`, (context) =>
    update(context, dependencies, context.req.param('id')),
  );
  registerTargetWrites(app, dependencies);
  return app;
}
