/**
 * Page-level arrangements (ID-19): narrow cards, rows of fields that wrap,
 * the agents' cards, and the choices and steps of a flow.
 */
export const LAYOUT = `.card.narrow {
  max-width: 32rem;
}
.form-row {
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  align-items: end;
}
.agent-card {
  display: grid;
  align-content: start;
  gap: 0.875rem;
  min-width: 0;
  padding: 1rem 1.125rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface-raised);
}
.agent-card h3 {
  font-size: 0.9375rem;
}
.agent-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.agent-foot:empty {
  display: none;
}
`;

/**
 * The Computers pages (ID-19): the list's name links and one-line
 * descriptions, the kinds to choose from, the form's cards and its actions,
 * the grants of a computer and the matrix of grants on the Agents page.
 */
export const COMPUTERS = `.strong {
  color: var(--text);
  font-weight: 650;
  text-decoration: none;
}
a.strong:hover {
  text-decoration: underline;
}
.clamp {
  max-width: 22rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bad {
  color: var(--bad);
  font-weight: 600;
}
.cell-sub.warn {
  color: var(--warn);
  font-weight: 600;
}
.computers td {
  vertical-align: top;
}
.computers th {
  white-space: nowrap;
}
.choices {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
  gap: 0.75rem;
}
.choice {
  display: flex;
  align-items: flex-start;
  gap: 0.875rem;
  padding: 1.125rem;
  border: 1.5px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  color: inherit;
  text-decoration: none;
}
.choice:hover {
  border-color: var(--text);
  box-shadow: 0 0 0 3px var(--focus-ring);
}
.choice-title {
  font-size: 0.9375rem;
  font-weight: 650;
}
.choice-text {
  color: var(--text-2);
  font-size: 0.8125rem;
}
.choice-meta {
  color: var(--link);
  font-family: var(--font-mono);
  font-size: 0.72rem;
}
.target-form {
  gap: 1rem;
}
.fields {
  display: grid;
  gap: 0.875rem;
}
.form-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.75rem;
}
.grants {
  display: grid;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  list-style: none;
}
.grant {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.grant form {
  margin-left: auto;
}
.grow {
  flex: 1;
}
.matrix th:not(:first-child),
.matrix td:not(:first-child) {
  text-align: center;
}
.matrix th .cell-with-tile {
  justify-content: center;
}
.square {
  display: inline-grid;
  width: 1.625rem;
  height: 1.625rem;
  place-items: center;
  border: 1.5px solid var(--off);
  border-radius: 7px;
  background: var(--surface);
}
.square.is-granted {
  border-color: var(--button);
  background: var(--button);
  color: var(--button-text);
}
.square .icon {
  width: 0.95rem;
  height: 0.95rem;
  stroke-width: 2.6;
}
.square-button {
  width: 2.75rem;
  min-height: 2.75rem;
  padding: 0;
  border: 0;
  background: transparent;
}
.square-button:hover .square {
  border-color: var(--text);
}
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
.trail-end {
  padding: 0.875rem 1.25rem;
}
`;
