/**
The single static stylesheet (ID-19), served from `/static/vaultgate.css`.
*/
export const STYLESHEET = `:root {
  color-scheme: light dark;
  font-family: system-ui, sans-serif;
  line-height: 1.5;
}
body {
  margin: 0;
  display: flex;
  justify-content: center;
  padding: 2rem 1rem;
}
main {
  width: 100%;
  max-width: 40rem;
}
h1 {
  font-size: 1.5rem;
  letter-spacing: 0.04em;
}
form {
  display: grid;
  gap: 0.75rem;
  margin-block: 1rem;
}
label {
  display: grid;
  gap: 0.25rem;
  font-weight: 600;
}
input,
button {
  font: inherit;
  padding: 0.5rem 0.75rem;
}
button {
  cursor: pointer;
  justify-self: start;
}
code,
pre {
  font-family: ui-monospace, monospace;
  overflow-wrap: anywhere;
}
.error {
  border-left: 4px solid #b00020;
  padding-left: 0.75rem;
}
.notice {
  border-left: 4px solid #2a7;
  padding-left: 0.75rem;
}
.codes {
  columns: 2;
  list-style: none;
  padding: 0;
}
table {
  border-collapse: collapse;
  width: 100%;
}
td,
th {
  border-bottom: 1px solid #8884;
  padding: 0.4rem 0.5rem;
  text-align: left;
}
section {
  border-top: 1px solid #8884;
  margin-top: 1.5rem;
  padding-top: 0.5rem;
}

/* ---- Narrow screens ------------------------------------------------------ */
/* Everything below keeps the pages usable on a phone without changing the */
/* desktop layout: overflow causes are fixed at every width, tables turn into */
/* stacked cards (each cell labelled from its data-label) at 640px and below, */
/* and touch targets grow on small or coarse-pointer screens. */
:root {
  font-size: 100%;
}
main {
  min-width: 0;
}
input,
select,
pre {
  box-sizing: border-box;
  max-width: 100%;
  min-width: 0;
}
select {
  font: inherit;
  padding: 0.5rem 0.75rem;
}
pre {
  overflow-x: auto;
  white-space: pre-wrap;
}
@media (max-width: 640px), (pointer: coarse) {
  input,
  select,
  button {
    min-height: 44px;
  }
  form a,
  p > a:only-child {
    display: inline-block;
    padding-block: 0.625rem;
  }
}
@media (max-width: 640px) {
  body {
    padding: 1rem 0.75rem;
  }
  form > button {
    justify-self: stretch;
    width: 100%;
  }
  table,
  tbody,
  tr {
    display: block;
  }
  thead {
    clip-path: inset(50%);
    height: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }
  tr {
    border: 1px solid #8884;
    border-radius: 0.375rem;
    margin-block: 0.75rem;
    padding: 0.5rem 0.75rem;
  }
  td {
    border-bottom: 0;
    display: flex;
    gap: 0.75rem;
    min-width: 0;
    overflow-wrap: anywhere;
    padding: 0.3rem 0;
  }
  td::before {
    content: attr(data-label);
    flex: 0 0 7rem;
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
    margin-block: 0.25rem 0;
    width: 100%;
  }
  td button {
    width: 100%;
  }
}
`;
