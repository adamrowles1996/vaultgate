/**
 * Vault items as the Computers pages show them (ID-19, ACT-4): the search
 * and its results, the chosen item on a form, and the note under a field
 * picker whose selection the item does not carry.
 */
export const ITEMS = `.search-form {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.75rem;
}
.search-form label {
  flex: 1 1 20rem;
}
details > summary {
  width: fit-content;
  color: var(--link);
  cursor: pointer;
  font-size: 0.875rem;
}
details[open] > summary {
  margin-bottom: 0.875rem;
}
.item-rows {
  display: grid;
  margin: 0;
  padding: 0;
  list-style: none;
}
.item-row {
  display: grid;
  grid-template-columns: minmax(12rem, 1fr) minmax(0, 1.4fr) auto;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 1.25rem;
  border-top: 1px solid var(--line-soft);
}
.item-mark {
  display: grid;
  width: 2rem;
  height: 2rem;
  flex: none;
  place-items: center;
  border-radius: 8px;
  background: var(--chip);
  color: var(--text-2);
}
.item-chosen {
  display: grid;
  gap: 0.625rem;
  padding: 0.875rem 1rem;
  border: 1px solid var(--line);
  border-radius: var(--radius-small);
  background: var(--surface-sunken);
}
small.warn {
  color: var(--warn);
  font-weight: 600;
}
@media (max-width: 640px) {
  .item-row {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.5rem;
  }
}
`;
