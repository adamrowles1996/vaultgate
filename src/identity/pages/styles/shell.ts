/**
 * The frames (ID-19): the console's sidebar, top bar and content column for
 * a signed-in operator, and the single centred card of the pages around
 * signing in (setup, sign-in, recovery codes, consent, not found).
 */
export const SHELL = `.skip-link {
  position: absolute;
  top: 0.75rem;
  left: -100vw;
  z-index: 10;
  padding: 0.5rem 0.75rem;
  border-radius: var(--radius-small);
  background: var(--surface);
}
.skip-link:focus {
  left: 0.75rem;
}
.shell {
  display: grid;
  grid-template-columns: 15rem minmax(0, 1fr);
  min-height: 100vh;
  background: linear-gradient(to right, var(--side) 15rem, var(--bg) 15rem);
}
.sidebar {
  position: sticky;
  top: 0;
  display: flex;
  flex-direction: column;
  gap: 1.125rem;
  height: 100vh;
  padding: 1.125rem 0.75rem 0.875rem;
  overflow-y: auto;
  background: var(--side);
  color: var(--side-text);
}
.brand {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.125rem 0.375rem;
}
.brand-mark {
  width: 1.875rem;
  height: 1.875rem;
  flex: none;
}
.brand-mark rect {
  fill: var(--brass);
}
.brand-mark path {
  fill: none;
  stroke: var(--brass-ink);
  stroke-width: 2.3;
  stroke-linecap: round;
}
.brand-mark circle {
  fill: var(--brass-ink);
}
.brand-name {
  color: var(--side-strong);
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: -0.01em;
}
.version {
  margin-left: auto;
  white-space: nowrap;
  padding: 0.1rem 0.35rem;
  border: 1px solid var(--side-line);
  border-radius: 5px;
  color: var(--side-muted);
  font-family: var(--font-mono);
  font-size: 0.66rem;
}
.cta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  min-height: 2.625rem;
  border-radius: var(--radius-small);
  background: var(--brass);
  color: var(--brass-ink);
  font-size: 0.875rem;
  font-weight: 650;
  text-decoration: none;
}
.cta:hover {
  background: var(--brass-hover);
}
.nav ul {
  display: grid;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.nav-item,
.nav-sub-item {
  display: flex;
  align-items: center;
  border-radius: 8px;
  color: var(--side-text);
  text-decoration: none;
}
.nav-item {
  gap: 0.7rem;
  min-height: 2.375rem;
  padding: 0 0.625rem;
  font-size: 0.875rem;
  font-weight: 500;
}
.nav-item .icon {
  color: var(--side-muted);
}
.nav-item:hover,
.nav-sub-item:hover {
  background: var(--side-sunken);
  color: var(--side-strong);
}
.nav-item[aria-current='page'] {
  background: var(--side-raised);
  color: var(--side-strong);
}
.nav-item[aria-current='page'] .icon {
  color: var(--brass);
}
.nav .nav-sub {
  gap: 1px;
  padding: 0.125rem 0 0.5rem;
}
.nav-sub-item {
  gap: 0.625rem;
  min-height: 1.875rem;
  padding: 0 0.625rem 0 2.4rem;
  color: var(--side-soft);
  font-size: 0.8125rem;
}
.nav-sub-item[aria-current='page'] {
  background: var(--side-sunken);
  color: var(--side-strong);
}
.nav-count {
  margin-left: auto;
  color: var(--side-muted);
  font-family: var(--font-mono);
  font-size: 0.72rem;
}
.nav-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  margin-left: auto;
  padding: 0.05rem 0.45rem;
  border-radius: 999px;
  background: #3a2a14;
  color: #f2b866;
  font-size: 0.7rem;
  font-weight: 650;
}
.nav-badge .icon {
  width: 0.7rem;
  height: 0.7rem;
  color: inherit;
}
.kind-dot {
  width: 0.45rem;
  height: 0.45rem;
  flex: none;
  border-radius: 2px;
  background: var(--side-muted);
}
.sidebar-foot {
  display: grid;
  gap: 0.625rem;
  margin-top: auto;
}
.vault-status {
  display: grid;
  gap: 0.2rem;
  padding: 0.7rem 0.75rem;
  border: 1px solid var(--side-line);
  border-radius: 10px;
  background: var(--side-sunken);
  text-decoration: none;
}
.status-line {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #e6e8eb;
  font-size: 0.8125rem;
  font-weight: 650;
}
.status-dot {
  width: 0.5rem;
  height: 0.5rem;
  flex: none;
  border-radius: 50%;
  background: var(--side-muted);
}
.vault-status.is-ready .status-dot {
  background: #3fb37f;
  box-shadow: 0 0 0 3px rgb(63 179 127 / 18%);
}
.vault-status.is-unavailable .status-dot {
  background: #e0803a;
}
.status-detail {
  color: var(--side-muted);
  font-size: 0.75rem;
}
.operator {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.25rem 0.25rem 0 0.375rem;
}
.avatar {
  display: grid;
  width: 2rem;
  height: 2rem;
  flex: none;
  place-items: center;
  border-radius: 50%;
  background: #2a2f37;
  color: #e6e8eb;
  font-size: 0.75rem;
  font-weight: 650;
}
.operator-text {
  display: grid;
  flex: 1;
  min-width: 0;
}
.operator-email {
  overflow: hidden;
  color: #e6e8eb;
  font-size: 0.8125rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.operator-text a {
  color: var(--side-muted);
  font-size: 0.75rem;
  text-decoration: none;
}
.operator-text a:hover,
.operator-text a[aria-current='page'] {
  color: var(--side-strong);
}
.operator form {
  display: block;
}
.icon-button {
  width: 2rem;
  min-height: 2rem;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--side-muted);
}
.icon-button:hover {
  background: var(--side-sunken);
  color: var(--side-strong);
}
.main {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.top-bar {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 1rem;
  min-height: 3.75rem;
  padding: 0 2rem;
  border-bottom: 1px solid var(--line);
  background: var(--bg);
}
`;
