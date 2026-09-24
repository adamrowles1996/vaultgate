/**
 * Lists and controls (ID-19): key and value lists, figures, empty states,
 * tabs and filters, the steps of a flow, choice cards, switches, two-line
 * table cells and the pieces of the consent and recovery-code pages. The
 * per-kind and per-agent colours are generated from one list each.
 */
const KINDS = ['mssql', 'postgres', 'winrm', 'ssh', 'http', 'graph'] as const;
const TONES = [1, 2, 3] as const;

const kindRules = KINDS.map(
  (kind) => `.kind-tile.kind-${kind} {
  background: var(--kind-${kind}-soft);
  color: var(--kind-${kind});
}
.kind-dot.kind-${kind},
.kind-mark.kind-${kind} {
  background: var(--kind-${kind}-dot);
}
`,
).join('');

const toneRules = TONES.map(
  (tone) => `.monogram.tone-${String(tone)} {
  background: var(--tone-${String(tone)}-soft);
  color: var(--tone-${String(tone)});
}
`,
).join('');

export const CONTROLS = `${kindRules}${toneRules}.kind-mark {
  display: inline-block;
  width: 0.5rem;
  height: 0.5rem;
  flex: none;
  border-radius: 2px;
  background: var(--off);
}
dl.kv {
  display: grid;
  grid-template-columns: minmax(6rem, 9rem) minmax(0, 1fr);
  margin: 0;
}
dl.kv dt,
dl.kv dd {
  margin: 0;
  padding: 0.55rem 0;
  border-bottom: 1px solid var(--line-soft);
}
dl.kv dt {
  color: var(--text-3);
  font-size: 0.8125rem;
}
dl.kv dd {
  overflow-wrap: anywhere;
}
dl.kv > :nth-last-child(-n + 2) {
  border-bottom: 0;
}
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 0;
  padding: 0;
}
.stat {
  display: grid;
  align-content: start;
  gap: 0.25rem;
  padding: 1rem 1.25rem;
  border-right: 1px solid var(--line-soft);
}
.stat:last-child {
  border-right: 0;
}
.stat-label {
  color: var(--text-3);
  font-size: 0.7rem;
  font-weight: 650;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.stat-value {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 650;
  overflow-wrap: anywhere;
}
.empty {
  padding: 1.5rem;
  color: var(--text-3);
  text-align: center;
}
.tabs,
.filters {
  display: flex;
  gap: 1.5rem;
  overflow-x: auto;
}
.tabs {
  border-bottom: 1px solid var(--line);
}
.tabs a {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  min-height: 2.5rem;
  margin-bottom: -1px;
  border-bottom: 2px solid transparent;
  color: var(--text-2);
  font-size: 0.875rem;
  font-weight: 500;
  text-decoration: none;
  white-space: nowrap;
}
.tabs a[aria-current='page'] {
  border-bottom-color: var(--text);
  color: var(--text);
  font-weight: 650;
}
.filters {
  flex-wrap: wrap;
  gap: 0.5rem;
}
.filters a {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  min-height: 2.125rem;
  padding: 0 0.75rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-2);
  font-size: 0.8125rem;
  font-weight: 650;
  text-decoration: none;
  white-space: nowrap;
}
.filters a[aria-current='page'] {
  border-color: var(--button);
  background: var(--button);
  color: var(--button-text);
}
.count {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 500;
}
.cell-main {
  display: grid;
  gap: 0.125rem;
  min-width: 0;
}
.cell-sub {
  color: var(--text-3);
  font-size: 0.8125rem;
}
.cell-with-tile {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}
tr.group-row td {
  padding-block: 0.5rem;
  background: var(--surface-sunken);
  color: var(--text);
  font-weight: 650;
}
.switch-row {
  display: flex;
  align-items: flex-start;
  gap: 1rem;
  font-weight: 500;
}
input[type='checkbox'].switch {
  position: relative;
  width: 2.75rem;
  height: 1.625rem;
  margin: 0;
  border-radius: 999px;
  background: var(--off);
  cursor: pointer;
  appearance: none;
}
input[type='checkbox'].switch::before {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 1.25rem;
  height: 1.25rem;
  border-radius: 50%;
  background: #ffffff;
  box-shadow: 0 1px 2px rgb(0 0 0 / 25%);
  content: '';
}
input[type='checkbox'].switch:checked {
  background: var(--button);
}
input[type='checkbox'].switch:checked::before {
  left: calc(100% - 1.25rem - 3px);
}
.codes {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.scopes {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.risk {
  padding: 0.05rem 0.4rem;
  border-radius: 5px;
  background: var(--bad-soft);
  color: var(--bad);
  font-size: 0.72rem;
}
.warning,
.actions-note {
  padding: 0.75rem 1rem;
  border: 1px solid var(--warn-line);
  border-radius: 10px;
  background: var(--warn-soft);
  color: var(--warn-strong);
  font-size: 0.875rem;
}
.button-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
`;
