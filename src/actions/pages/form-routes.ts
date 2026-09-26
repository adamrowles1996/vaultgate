/**
 * "Add computer" and "Edit" (ACT-2, ACT-4, ACT-5, ACT-6): the kind, then the
 * vault item, then the connector's form with the item's fields to pick from,
 * and the `POST`s that save through the targets service so its ACT-7 event is
 * recorded there. A rejected create or edit answers `400` with the form
 * re-rendered, every problem listed and the submitted values shown again.
 * Outside the ID-15 window every step after the kind offers Unlock editing
 * and reads nothing from the vault; inside it, every vault read of a page
 * load is metadata only. A code form's token is read on Check without
 * saving alone (ACT-119, ACT-120), which is a `POST` behind the gate.
 */
import { CHECK_INTENT, INTENT_FIELD, withRefusals } from './check-report.ts';
import { repoOffer as repoOffer } from './code-github.ts';
import { formCheck } from './form-check.ts';
import {
  editableForm,
  submitted,
  targetInputFromForm,
  text,
  withParameters,
} from './form-input.ts';
import {
  createFrame,
  createPage,
  editFrame,
  editPage,
  kindChooserPage,
  lockedPage,
} from './form-pages.ts';
import { formFor } from './forms.ts';
import { ITEM_PARAM, QUERY_PARAM } from './item-picker.ts';
import { chosenItem, renderPicker } from './item-step.ts';
import { kindOf } from './kinds.ts';
import { editPath, NEW_PATH, targetPath } from './paths.ts';
import { formKind, kindChoices, prefilled } from './prefill.ts';
import { type ChosenItem, CONNECTOR_FIELD, ITEM_ID_FIELD } from './target-form.ts';
import {
  type ActionsPagesDependencies,
  fieldProblems,
  signedIn,
  targetValues,
  type Viewer,
  viewerOf,
} from './view.ts';

import type { ConnectorForm } from './descriptors.ts';
import type { FormPageView } from './form-pages.ts';
import type { FormValues } from './form-values.ts';
import type { IdentityContext } from '../../identity/index.ts';
import type { TargetSummary } from '../targets.ts';

const KIND_PARAM = 'kind';
const CHANGE_PARAM = 'change';

/**
The parameters that keep a create on its connector and kind from one step to the next.
*/
function createParameters(form: ConnectorForm, kind: string | undefined): Record<string, string> {
  return { [CONNECTOR_FIELD]: form.kind, ...(kind !== undefined && { [KIND_PARAM]: kind }) };
}

interface CreateRequest {
  readonly form: ConnectorForm;
  readonly values: FormValues;
  readonly problems?: readonly string[];
  readonly check?: FormPageView['check'];
}

function isCheck(values: FormValues): boolean {
  return values.get(INTENT_FIELD) === CHECK_INTENT;
}

/**
 * The form's part of a create or an edit page. The token's repositories are
 * listed only when the form comes back from Check without saving (ACT-119):
 * no page load reads a secret.
 */
async function formView(
  dependencies: ActionsPagesDependencies,
  viewer: Viewer,
  request: CreateRequest,
  item: ChosenItem,
): Promise<FormPageView> {
  const { form, values, check } = request;
  const offer = { form, values, item, isReauthenticated: viewer.isReauthenticated };
  return {
    csrfToken: viewer.csrfToken,
    problems: fieldProblems(form, request.problems),
    form,
    values,
    item,
    repositories: await repoOffer(dependencies, { ...offer, isChecking: check !== undefined }),
    ...(check !== undefined && { check }),
  };
}

async function renderCreate(
  dependencies: ActionsPagesDependencies,
  viewer: Viewer,
  request: CreateRequest,
): Promise<string> {
  const { form, values } = request;
  const kind = formKind(form, values);
  const restart = withParameters(NEW_PATH, createParameters(form, kind));
  const itemId = text(values, ITEM_ID_FIELD);
  const returnTo = withParameters(NEW_PATH, {
    ...createParameters(form, kind),
    [ITEM_PARAM]: itemId,
  });
  const item = await chosenItem(dependencies, itemId, restart);
  const view = await formView(dependencies, viewer, request, item);
  return dependencies.renderConsole(viewer.session, createPage(createFrame(kind, returnTo), view));
}

async function showCreate(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
): Promise<Response> {
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
  const kindParameter = context.req.query(KIND_PARAM);
  const values = new Map(prefilled(form, kindParameter));
  const itemId = (context.req.query(ITEM_PARAM) ?? '').trim();
  const url = new URL(context.req.url);
  const frame = createFrame(formKind(form, values), `${url.pathname}${url.search}`);
  if (!viewer.isReauthenticated) {
    const page = lockedPage(frame, 'Adding a connection');
    return context.html(await dependencies.renderConsole(viewer.session, page));
  }
  if (itemId === '') {
    const carried = createParameters(form, kindParameter);
    const query = (context.req.query(QUERY_PARAM) ?? '').trim();
    const request = { frame, action: NEW_PATH, carried, picked: carried, query };
    return context.html(await renderPicker(dependencies, viewer, request));
  }
  values.set(ITEM_ID_FIELD, itemId);
  return context.html(await renderCreate(dependencies, viewer, { form, values }));
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
  const viewer = viewerOf(gate.session);
  const { values, refused } = submitted(dependencies, form, gate.form);
  if (isCheck(gate.form)) {
    const found = await dependencies.targets.checkNew(targetInputFromForm(form, values, true));
    const report = withRefusals(found, refused);
    const check = await formCheck(dependencies, viewer, { form, values }, report);
    const request = { form, values, problems: report.problems, check };
    return context.html(await renderCreate(dependencies, viewer, request));
  }
  if (refused.length > 0) {
    const request = { form, values, problems: refused };
    return context.html(await renderCreate(dependencies, viewer, request), 400);
  }
  const created = await dependencies.targets.create(
    targetInputFromForm(form, values, true),
    gate.operatorId,
  );
  if (created.ok) {
    return context.redirect(`${targetPath(created.value.id)}?notice=created`, 303);
  }
  const request = { form, values, problems: created.error.problems };
  return context.html(await renderCreate(dependencies, viewer, request), 400);
}

interface Editable {
  readonly target: TargetSummary;
  readonly form: ConnectorForm;
}

/**
The connector's form and the target as it is now, or `undefined` when either is missing.
*/
function editable(dependencies: ActionsPagesDependencies, id: string): Editable | undefined {
  const target = dependencies.targets.get(id);
  const form = target === undefined ? undefined : formFor(target.connector, dependencies.switches);
  return target === undefined || form === undefined ? undefined : { target, form };
}

type EditRequest = Omit<CreateRequest, 'form'>;

async function renderEdit(
  dependencies: ActionsPagesDependencies,
  viewer: Viewer,
  current: Editable,
  request: EditRequest,
): Promise<string> {
  const { target, form } = current;
  const itemId = text(request.values, ITEM_ID_FIELD);
  const changeHref = withParameters(editPath(target.id), { [CHANGE_PARAM]: ITEM_PARAM });
  const frame = editFrame(target, editPath(target.id));
  const item = await chosenItem(dependencies, itemId, changeHref);
  const view = await formView(dependencies, viewer, { ...request, form }, item);
  const page = editPage(frame, { ...view, targetId: target.id, kind: kindOf(target) });
  return dependencies.renderConsole(viewer.session, page);
}

/**
 * The edit step asked for: the form with the item it maps, or with one just
 * chosen (`?item=`, which wins), or the item picker (`?change=item`).
 */
async function showEdit(
  context: IdentityContext,
  dependencies: ActionsPagesDependencies,
  id: string,
): Promise<Response> {
  const viewer = signedIn(context, dependencies.consoleAccess);
  if (viewer instanceof Response) {
    return viewer;
  }
  const current = editable(dependencies, id);
  if (current === undefined) {
    return context.notFound();
  }
  const url = new URL(context.req.url);
  const frame = editFrame(current.target, `${url.pathname}${url.search}`);
  if (!viewer.isReauthenticated) {
    const page = lockedPage(frame, 'Changing a connection');
    return context.html(await dependencies.renderConsole(viewer.session, page));
  }
  const picked = (context.req.query(ITEM_PARAM) ?? '').trim();
  if (picked === '' && context.req.query(CHANGE_PARAM) === ITEM_PARAM) {
    const query = (context.req.query(QUERY_PARAM) ?? '').trim();
    const carried = { [CHANGE_PARAM]: ITEM_PARAM };
    const request = { frame, action: editPath(id), carried, picked: {}, query };
    return context.html(await renderPicker(dependencies, viewer, request));
  }
  const values = new Map(targetValues(current.form, current.target));
  if (picked !== '') {
    values.set(ITEM_ID_FIELD, picked);
  }
  return context.html(await renderEdit(dependencies, viewer, current, { values }));
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
  const { form } = current;
  const { values, refused } = submitted(dependencies, form, gate.form);
  if (isCheck(gate.form)) {
    const input = targetInputFromForm(form, values, false);
    const found = await dependencies.targets.checkChanges(current.target.connector, input);
    const report = withRefusals(found, refused);
    const check = await formCheck(dependencies, viewer, { form, values }, report);
    const request = { values, problems: report.problems, check };
    return context.html(await renderEdit(dependencies, viewer, current, request));
  }
  if (refused.length > 0) {
    const request = { values, problems: refused };
    return context.html(await renderEdit(dependencies, viewer, current, request), 400);
  }
  const updated = await dependencies.targets.update(
    current.target.id,
    targetInputFromForm(form, values, false),
    gate.operatorId,
  );
  if (updated.ok) {
    return context.redirect(`${targetPath(current.target.id)}?notice=updated`, 303);
  }
  const request = { values, problems: updated.error.problems };
  return context.html(await renderEdit(dependencies, viewer, current, request), 400);
}

export const formRoutes = { showCreate, create, showEdit, update };
