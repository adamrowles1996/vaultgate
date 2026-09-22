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
`;
