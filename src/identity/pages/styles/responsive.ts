/**
 * Narrow screens (ID-19). The pages stay usable on a phone without changing
 * the desktop layout: below 960px the sidebar becomes a bar across the top,
 * overflow causes are fixed at every width, tables turn into stacked cards
 * (each cell labelled from its `data-label`) at 640px and below, and touch
 * targets grow on small or coarse-pointer screens.
 */
export const RESPONSIVE = `@media (max-width: 960px) {
  .shell {
    grid-template-columns: minmax(0, 1fr);
    background: var(--bg);
  }
  .sidebar {
    position: static;
    gap: 0.75rem;
    height: auto;
    padding: 0.75rem;
    overflow: visible;
  }
  .nav > ul {
    display: flex;
    overflow-x: auto;
  }
  .nav .nav-sub {
    display: none;
  }
  .sidebar-foot {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    margin-top: 0;
  }
  .top-bar {
    position: static;
    padding: 0.5rem 1rem;
  }
  .content {
    padding: 1.25rem 1rem 2rem;
  }
  .grid-2 {
    grid-template-columns: minmax(0, 1fr);
  }
}
@media (max-width: 640px), (pointer: coarse) {
  input,
  select,
  button {
    min-height: 44px;
  }
  .nav-item,
  .nav-sub-item,
  .lock-chip {
    min-height: 44px;
  }
  form a,
  p > a:only-child {
    display: inline-block;
    padding-block: 0.625rem;
  }
}
@media (max-width: 640px) {
  body.plain {
    padding: 1.5rem 0.75rem;
  }
  .plain-card {
    padding: 1.25rem;
  }
  form > button {
    justify-self: stretch;
    width: 100%;
  }
  .page-actions {
    margin-left: 0;
  }
  dl.kv {
    grid-template-columns: minmax(0, 1fr);
  }
  dl.kv dt {
    padding-bottom: 0;
    border-bottom: 0;
  }
  .codes {
    grid-template-columns: minmax(0, 1fr);
  }
  table,
  tbody,
  tr {
    display: block;
  }
  thead {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  tr {
    margin: 0.75rem;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--line);
    border-radius: var(--radius-small);
  }
  td {
    display: flex;
    gap: 0.75rem;
    min-width: 0;
    padding: 0.3rem 0;
    border-bottom: 0;
    overflow-wrap: anywhere;
  }
  td::before {
    flex: 0 0 7rem;
    color: var(--text-3);
    content: attr(data-label);
    font-weight: 600;
  }
  td > * {
    min-width: 0;
  }
  td[data-label='']::before {
    content: none;
  }
  td:empty {
    display: none;
  }
  td form {
    width: 100%;
    margin-block: 0.25rem 0;
  }
  td button {
    width: 100%;
  }
  tr.group-row {
    margin-block: 1rem 0;
    padding: 0;
    border: 0;
  }
  tr.group-row td {
    background: transparent;
  }
}
`;
