/**
 * The rest of the frames (ID-19): the breadcrumb and editing lock of the top
 * bar, the content column and its page heading, and the centred card around
 * signing in.
 */
export const FRAME = `.crumbs ol {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  padding: 0;
  color: var(--text-3);
  font-size: 0.875rem;
  list-style: none;
}
.crumbs li + li::before {
  margin-right: 0.5rem;
  color: var(--off);
  content: '/';
}
.crumbs a {
  color: var(--text-3);
  text-decoration: none;
}
.crumbs a:hover {
  color: var(--text);
}
.crumbs [aria-current='page'] {
  color: var(--text);
  font-weight: 600;
}
.top-bar-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  margin-left: auto;
}
.lock-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 2.25rem;
  padding: 0 0.75rem;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
  color: var(--text-2);
  font-size: 0.8125rem;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
}
.lock-chip.is-unlocked {
  border-color: var(--brass-soft-line);
  background: var(--brass-soft);
  color: var(--brass-soft-text);
}
.content {
  display: grid;
  align-content: start;
  gap: 1.25rem;
  width: 100%;
  max-width: 80rem;
  padding: 1.75rem 2rem 3rem;
}
.page-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 1rem;
}
.page-head > div:first-child {
  display: grid;
  gap: 0.375rem;
  min-width: 0;
}
.page-head > div.cell-with-tile:first-child {
  display: flex;
  align-items: center;
  gap: 1rem;
}
h1.mono {
  font-size: 1.625rem;
  letter-spacing: -0.01em;
}
.intro {
  max-width: 56rem;
  color: var(--text-2);
  font-size: 0.9375rem;
}
.page-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-left: auto;
}
.page-actions form {
  display: block;
}
body.plain {
  display: grid;
  min-height: 100vh;
  padding: 3rem 1rem;
  place-items: start center;
}
.plain-main {
  display: grid;
  gap: 1.25rem;
  width: 100%;
  max-width: 32rem;
}
.plain-brand {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.plain-card {
  display: grid;
  gap: 1rem;
  padding: 1.75rem;
  border: 1px solid var(--line);
  border-radius: 16px;
  background: var(--surface);
  box-shadow: var(--shadow);
}
.plain-card h2 {
  font-size: 1.375rem;
  letter-spacing: -0.01em;
}
.plain-card form > button {
  justify-self: stretch;
}
`;
