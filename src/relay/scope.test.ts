import { describe, expect, it } from 'vitest';

import { RELAY_ID, RELAY_ITEMS, relayVault } from '../test-support/relay-fixtures.ts';
import { unwrapOk } from '../test-support/result.ts';

import { createScope, findInScope, isInScope } from './scope.ts';

function summary(id: string): (typeof RELAY_ITEMS)[number]['summary'] {
  const item = RELAY_ITEMS.find((candidate) => candidate.summary.id === id);
  if (item === undefined) {
    throw new Error(`no fixture item ${id}`);
  }
  return item.summary;
}

describe('the whole-vault scope', () => {
  it('RELAY-12 answers every live login and secure note, listed or not', () => {
    const all = createScope([], [], true);
    expect(isInScope(all, summary(RELAY_ID.outside))).toBe(true);
    expect(isInScope(all, summary(RELAY_ID.note))).toBe(true);
    expect(isInScope(all, summary(RELAY_ID.trashed))).toBe(false);
    expect(isInScope(all, summary(RELAY_ID.card))).toBe(false);
    expect(isInScope(createScope([], []), summary(RELAY_ID.outside))).toBe(false);
  });

  it('RELAY-12 finds an item outside every listed collection by name', async () => {
    const found = unwrapOk(
      await findInScope(relayVault(), createScope([], [], true), 'Payroll database'),
    );
    expect(found.map((item) => item.id)).toStrictEqual([RELAY_ID.outside]);
  });
});
