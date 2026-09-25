/**
 * The Computers page (ACT-5): every target an agent may be granted, grouped
 * by kind, with its address, the vault item and fields it signs in with
 * (secret fields sealed, never a value), what it allows, the agents granted
 * it, its last call and its state; what needs attention first, and a filter
 * per kind. Read-only; every change starts from a computer's own page.
 */
import { icon } from '../../identity/pages/icons.ts';
import {
  cell,
  EMPTY,
  type Html,
  html,
  noticeBanner,
  tableHead,
  when,
} from '../../identity/pages/template.ts';
import {
  fieldChip,
  monogram,
  pageHead,
  pill,
  relativeTime,
  sealed,
} from '../../identity/pages/ui.ts';

import { outcomeTag } from './calls.ts';
import { type ComputerKind, KIND_ORDER, KINDS } from './kinds.ts';
import { CREATE_PATH, NEW_PATH, targetPath, UNEXPECTED_PATH } from './paths.ts';

import type { ComputerSummary, Confirmation, MappedField } from './summary.ts';
import type { ConsolePage } from '../../identity/index.ts';

export interface AgentChip {
  readonly clientId: string;
  readonly name: string;
}

export interface ComputerRow {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly summary: ComputerSummary;
  /**
  The vault item's name (ACT-4), or why it could not be read.
  */
  readonly itemName: string;
  readonly isItemMissing: boolean;
  readonly problems: readonly string[];
  readonly agents: readonly AgentChip[];
  readonly lastCall: { readonly at: number; readonly outcome: string } | undefined;
}

export interface ComputersView {
  readonly rows: readonly ComputerRow[];
  readonly filter: ComputerKind | undefined;
  readonly now: number;
  /**
  ACT-63: unexpected writes in the last seven days, for the attention strip.
  */
  readonly unexpectedCount: number;
  readonly notice?: string | undefined;
}

const COLUMNS = [
  'Connection',
  'Address',
  'Signs in with',
  'Allows',
  'Agents',
  'Last call',
  'Status',
] as const;

const STATE_PILLS = {
  enabled: pill('ok', 'Enabled'),
  disabled: pill('off', 'Disabled'),
  invalid: pill('bad', 'Needs fixing'),
} as const;

const CONFIRMATIONS: Readonly<Record<Confirmation, Html>> = {
  confirmed: html`<span class="cell-sub">${icon('shield')} A person confirms writes</span>`,
  unconfirmed: html`<span class="cell-sub warn">${icon('alert')} Writes are not confirmed</span>`,
  reads: html`<span class="cell-sub">Reads only</span>`,
};

function fields(list: readonly MappedField[]): Html {
  return html`<span class="chips"
    >${list.map((field) => (field.isSecret ? sealed(field.selector) : fieldChip(field.selector)))}</span
  >`;
}

function computerCell(row: ComputerRow): Html {
  const kind = KINDS[row.summary.kind];
  return html`<span class="cell-with-tile"
    ><span class="kind-tile kind-${row.summary.kind}" title="${kind.label}">${icon(kind.icon)}</span
    ><span class="cell-main"
      ><a class="mono strong" href="${targetPath(row.id)}">${row.name}</a
      ><span class="cell-sub clamp">${row.description}</span></span
    ></span
  >`;
}

function itemCell(row: ComputerRow): Html {
  const name = row.isItemMissing
    ? html`<span class="bad">${icon('alert')} ${row.itemName}</span>`
    : html`<span>${icon('vault')} ${row.itemName}</span>`;
  return html`<span class="cell-main">${name}${fields(row.summary.fields)}</span>`;
}

function lastCallCell(row: ComputerRow, now: number): Html {
  const call = row.lastCall;
  if (call === undefined) {
    return html`<span class="cell-sub">No calls yet</span>`;
  }
  return html`<span class="cell-main"
    ><span>${relativeTime(call.at, now)}</span>${outcomeTag(call.outcome)}</span
  >`;
}

function agentsCell(agents: readonly AgentChip[]): Html {
  return agents.length === 0
    ? html`<span class="cell-sub">None</span>`
    : html`<span class="monograms"
        >${agents.map((agent) => monogram(agent.clientId, agent.name))}</span
      >`;
}

function row(computer: ComputerRow, now: number): Html {
  const { summary } = computer;
  return html`<tr>
    ${cell(COLUMNS[0], computerCell(computer))}
    ${cell(
      COLUMNS[1],
      html`<span class="cell-main"
        ><span class="mono">${summary.address}</span
        ><span class="cell-sub">${summary.addressDetail}</span></span
      >`,
    )}
    ${cell(COLUMNS[2], itemCell(computer))}
    ${cell(
      COLUMNS[3],
      html`<span class="cell-main"
        ><span>${summary.allows}</span>${CONFIRMATIONS[summary.confirmation]}</span
      >`,
    )}
    ${cell(COLUMNS[4], agentsCell(computer.agents))}
    ${cell(COLUMNS[5], lastCallCell(computer, now))} ${cell(COLUMNS[6], STATE_PILLS[summary.state])}
  </tr>`;
}

function groupRow(kind: ComputerKind, count: number): Html {
  const description = KINDS[kind];
  return html`<tr class="group-row">
    <td colspan="${COLUMNS.length}" data-label="">
      <span class="cell-with-tile"
        ><span class="kind-tile small kind-${kind}">${icon(description.icon)}</span
        >${description.plural} <span class="count">${count}</span
        ><span class="spacer mono cell-sub">${description.tools}</span></span
      >
    </td>
  </tr>`;
}

function body(view: ComputersView): Html {
  const shown = view.rows.filter(
    (computer) => view.filter === undefined || computer.summary.kind === view.filter,
  );
  const groups = KIND_ORDER.map((kind) => {
    const rows = shown.filter((computer) => computer.summary.kind === kind);
    return rows.length === 0
      ? EMPTY
      : html`${when(view.filter === undefined, () => groupRow(kind, rows.length))}
        ${rows.map((computer) => row(computer, view.now))}`;
  });
  return html`<section class="card flush">
    <table class="computers">
      ${tableHead(COLUMNS)}
      <tbody>
        ${groups}
      </tbody>
    </table>
  </section>`;
}

function filters(view: ComputersView): Html {
  const kinds = KIND_ORDER.filter((kind) => view.rows.some((row) => row.summary.kind === kind));
  const link = (label: string, href: string, count: number, isCurrent: boolean) =>
    html`<a href="${href}" ${when(isCurrent, () => html`aria-current="page"`)}
      >${label} <span class="count">${count}</span></a
    >`;
  return html`<nav class="filters" aria-label="Kinds of connection">
    ${link('All', CREATE_PATH, view.rows.length, view.filter === undefined)}
    ${kinds.map((kind) =>
      link(
        KINDS[kind].plural,
        `${CREATE_PATH}?kind=${kind}`,
        view.rows.filter((row) => row.summary.kind === kind).length,
        view.filter === kind,
      ),
    )}
  </nav>`;
}

function attention(view: ComputersView): Html {
  const items = [
    ...view.rows
      .filter((row) => row.summary.state === 'invalid')
      .map(
        (row) =>
          html`<a href="${targetPath(row.id)}"
            ><span class="mono">${row.name}</span> needs fixing</a
          >`,
      ),
    ...view.rows
      .filter((row) => row.summary.confirmation === 'unconfirmed')
      .map(
        (row) =>
          html`<a href="${targetPath(row.id)}"
            ><span class="mono">${row.name}</span> changes things without a person’s OK</a
          >`,
      ),
    ...(view.unexpectedCount > 0
      ? [html`<a href="${UNEXPECTED_PATH}">${view.unexpectedCount} unexpected writes this week</a>`]
      : []),
  ];
  return when(
    items.length > 0,
    () =>
      html`<div class="attention" role="status">
        ${icon('alert')}<strong>Needs attention</strong>${items}
      </div>`,
  );
}

function emptyState(): Html {
  return html`<section class="card">
    <div class="empty">
      <p><strong>No connections yet.</strong></p>
      <p>Add one to let an agent use a sign-in from your vault without ever seeing it.</p>
      <p><a class="button primary" href="${NEW_PATH}">${icon('plus')}Add connection</a></p>
    </div>
  </section>`;
}

export function computersPage(view: ComputersView): ConsolePage {
  const content =
    view.rows.length === 0 ? emptyState() : html`${attention(view)} ${filters(view)} ${body(view)}`;
  return {
    title: 'Connections',
    active: 'computers',
    crumbs: [{ label: 'Connections' }],
    body: html`${pageHead(
      'Connections',
      'Everything your agents can reach through vaultgate. They use each sign-in; they never see it.',
    )}
    ${noticeBanner(view.notice)} ${content}`,
    returnTo: CREATE_PATH,
  };
}
