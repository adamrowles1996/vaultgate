/**
 * The console's building blocks (ID-19): cards and grids, banners, status
 * pills and tags, the field chips, the hatched "sealed" chip every secret
 * field is drawn as, the kind tiles of computers and the agents' monograms.
 */
export const COMPONENTS = `.card {
  display: grid;
  align-content: start;
  gap: 1rem;
  min-width: 0;
  padding: 1.25rem 1.375rem;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow);
}
.card.flush {
  gap: 0;
  padding: 0;
  overflow: hidden;
}
.card.flush > .card-head {
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--line);
}
.card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 0.75rem;
}
.card-head > div:first-child {
  display: grid;
  flex: 1;
  gap: 0.25rem;
  min-width: 0;
}
.card-actions {
  display: flex;
  flex: none;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.card-note,
.muted {
  color: var(--text-3);
  font-size: 0.8125rem;
}
.grid-2 {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 1.25rem;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  gap: 1rem;
}
.stack {
  display: grid;
  gap: 1rem;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.toolbar form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.spacer {
  margin-left: auto;
}
.error,
.notice,
.attention {
  padding: 0.75rem 1rem;
  border: 1px solid;
  border-radius: 10px;
  font-size: 0.875rem;
}
.error {
  border-color: var(--bad-line);
  background: var(--bad-soft);
  color: var(--bad);
}
ul.error {
  padding-left: 2rem;
}
.notice {
  border-color: var(--ok-line);
  background: var(--ok-soft);
  color: var(--ok);
}
.attention {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
  border-color: var(--warn-line);
  background: var(--warn-soft);
  color: var(--warn-strong);
}
.attention a {
  color: inherit;
}
.field-error {
  color: var(--bad);
  font-size: 0.8125rem;
  font-weight: 600;
}
.pill,
.tag {
  display: inline-flex;
  align-items: center;
  justify-self: start;
  font-size: 0.75rem;
  font-weight: 650;
  white-space: nowrap;
}
.pill {
  gap: 0.375rem;
  padding: 0.125rem 0.6rem;
  border-radius: 999px;
  background: var(--chip);
  color: var(--text-2);
}
.pill::before {
  width: 0.375rem;
  height: 0.375rem;
  border-radius: 50%;
  background: var(--off);
  content: '';
}
.pill-ok {
  background: var(--ok-soft);
  color: var(--ok);
}
.pill-ok::before {
  background: var(--ok-dot);
}
.pill-bad {
  background: var(--bad-soft);
  color: var(--bad);
}
.pill-bad::before {
  background: var(--bad-dot);
}
.pill-warn {
  background: var(--warn-soft);
  color: var(--warn);
}
.pill-warn::before {
  background: var(--warn-dot);
}
.tag {
  gap: 0.3rem;
  padding: 0.1rem 0.5rem;
  border-radius: 6px;
  background: var(--chip);
  color: var(--chip-text);
}
.tag .icon {
  width: 0.8rem;
  height: 0.8rem;
}
.tag-amber {
  background: var(--warn-soft);
  color: var(--warn);
}
.tag-green {
  background: var(--ok-soft);
  color: var(--ok);
}
.tag-brass {
  background: var(--brass-soft);
  color: var(--brass-soft-text);
}
.tag-red {
  background: var(--bad-soft);
  color: var(--bad);
}
.field-chip {
  padding: 0.05rem 0.45rem;
  border-radius: 5px;
  background: var(--chip);
  color: var(--chip-text);
  font-family: var(--font-mono);
  font-size: 0.7rem;
  white-space: nowrap;
}
.sealed {
  display: inline-flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.2rem 0.6rem;
  border-radius: 6px;
  border: 1px solid rgb(235 207 142 / 18%);
  background: repeating-linear-gradient(135deg, #1c1f24 0 5px, #272b32 5px 10px);
  color: #ebcf8e;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 500;
  white-space: nowrap;
}
.sealed .icon {
  width: 0.8rem;
  height: 0.8rem;
  stroke-width: 2.1;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.kind-tile {
  display: grid;
  width: 2rem;
  height: 2rem;
  flex: none;
  place-items: center;
  border-radius: 8px;
  background: var(--chip);
  color: var(--text-2);
}
.kind-tile.small {
  width: 1.375rem;
  height: 1.375rem;
  border-radius: 6px;
}
.kind-tile.small .icon {
  width: 0.8rem;
  height: 0.8rem;
}
.kind-tile.large {
  width: 3.25rem;
  height: 3.25rem;
  border-radius: 12px;
}
.kind-tile.large .icon {
  width: 1.6rem;
  height: 1.6rem;
}
.monogram {
  display: inline-grid;
  width: 1.5rem;
  height: 1.5rem;
  flex: none;
  place-items: center;
  border: 2px solid var(--surface);
  border-radius: 50%;
  background: var(--tone-0-soft);
  color: var(--tone-0);
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}
.monogram.large {
  width: 2.5rem;
  height: 2.5rem;
  font-size: 0.8125rem;
}
.monograms {
  display: inline-flex;
}
.monograms .monogram + .monogram {
  margin-left: -0.375rem;
}
`;
