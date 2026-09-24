/**
 * Element defaults (ID-19): type, links, forms, buttons and tables as every
 * page draws them, whether inside the console or on a sign-in card.
 */
export const BASE = `*,
*::before,
*::after {
  box-sizing: border-box;
}
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-sans);
  font-size: 0.9375rem;
}
main {
  min-width: 0;
}
h1,
h2,
h3 {
  margin: 0;
  line-height: 1.25;
}
h1 {
  font-size: 1.75rem;
  font-weight: 650;
  letter-spacing: -0.015em;
}
h2 {
  font-size: 1.0625rem;
  font-weight: 650;
}
h3 {
  font-size: 0.9375rem;
  font-weight: 650;
}
p {
  margin: 0;
}
a {
  color: var(--link);
  text-underline-offset: 0.18em;
}
:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
code,
pre,
.mono {
  font-family: var(--font-mono);
  font-size: 0.875em;
  overflow-wrap: anywhere;
}
code {
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
  background: var(--chip);
  color: var(--chip-text);
}
pre {
  margin: 0;
  padding: 0.75rem 0.875rem;
  border-radius: var(--radius-small);
  border: 1px solid var(--line);
  background: var(--surface-sunken);
  overflow-x: auto;
  white-space: pre-wrap;
}
.icon {
  width: 1.125rem;
  height: 1.125rem;
  flex: none;
  fill: none;
  stroke: currentcolor;
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}
form {
  display: grid;
  gap: 0.875rem;
  margin: 0;
}
label {
  display: grid;
  gap: 0.3rem;
  font-size: 0.875rem;
  font-weight: 600;
}
label small,
fieldset small,
.help {
  display: block;
  color: var(--text-3);
  font-size: 0.8125rem;
  font-weight: 400;
  line-height: 1.45;
}
input,
select,
textarea,
button {
  font: inherit;
  color: inherit;
}
input,
select,
textarea {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  padding: 0.55rem 0.75rem;
  border: 1.5px solid var(--field-line);
  border-radius: var(--radius-small);
  background: var(--surface);
  color: var(--text);
  font-weight: 400;
}
textarea {
  min-height: 5.5rem;
  resize: vertical;
}
input:focus,
select:focus,
textarea:focus {
  border-color: var(--text);
  box-shadow: 0 0 0 3px var(--focus-ring);
  outline: none;
}
input[type='checkbox'],
input[type='radio'] {
  width: 1.05rem;
  height: 1.05rem;
  margin: 0.15rem 0 0;
  flex: none;
  accent-color: var(--button);
}
label:has(> input[type='checkbox']),
label:has(> input[type='radio']) {
  display: flex;
  align-items: flex-start;
  gap: 0.6rem;
  font-weight: 500;
}
fieldset {
  display: grid;
  gap: 0.875rem;
  min-width: 0;
  margin: 0;
  padding: 1rem 1.125rem 1.125rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
}
legend {
  padding: 0 0.375rem;
  font-weight: 650;
}
button,
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  justify-self: start;
  gap: 0.5rem;
  min-height: 2.5rem;
  padding: 0 1rem;
  border: 1px solid var(--field-line);
  border-radius: var(--radius-small);
  background: var(--surface);
  color: var(--text);
  font-size: 0.875rem;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}
button:hover,
.button:hover {
  background: var(--surface-sunken);
}
button.primary,
.button.primary {
  border-color: var(--button);
  background: var(--button);
  color: var(--button-text);
}
button.primary:hover,
.button.primary:hover {
  opacity: 0.9;
}
button.danger,
.button.danger {
  border-color: var(--bad-line);
  color: var(--bad);
}
button.ghost,
.button.ghost {
  border-color: transparent;
  background: transparent;
}
button.small,
.button.small {
  min-height: 2.125rem;
  padding: 0 0.75rem;
  font-size: 0.8125rem;
}
button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}
th {
  padding: 0.6rem 0.875rem;
  border-bottom: 1px solid var(--line);
  background: var(--surface-raised);
  color: var(--text-3);
  font-size: 0.72rem;
  font-weight: 650;
  letter-spacing: 0.05em;
  text-align: left;
  text-transform: uppercase;
}
td {
  padding: 0.7rem 0.875rem;
  border-bottom: 1px solid var(--line-soft);
  text-align: left;
  vertical-align: middle;
}
tbody tr:last-child td {
  border-bottom: 0;
}
td form {
  margin: 0;
}
`;
