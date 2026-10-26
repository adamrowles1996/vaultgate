import { describe, expect, it } from 'vitest';

import { unwrapFail, unwrapOk } from '../test-support/result.ts';

import { type ExistingField, planFieldEdits } from './field-edits.ts';

import type { CustomFieldEdits } from './client.ts';

const ITEM: readonly ExistingField[] = [
  { name: 'Application ID', kind: 'hidden' },
  { name: 'environment', kind: 'text' },
  { name: 'mfa', kind: 'boolean' },
  { name: 'linked', kind: 'linked' },
];

function refusal(existing: readonly ExistingField[], edits: CustomFieldEdits): string {
  const error = unwrapFail(planFieldEdits(existing, edits));
  expect(error.code).toBe('invalid_item');
  return error.message;
}

describe('planFieldEdits', () => {
  it('MCP-17 keeps every field, in order, when nothing is asked', () => {
    expect(unwrapOk(planFieldEdits(ITEM, {}))).toStrictEqual(
      ITEM.map((field) => ({ keep: field, name: field.name, kind: field.kind })),
    );
  });

  it('MCP-17 renames in place keeping the value, removes, rewrites and appends', () => {
    const plan = unwrapOk(
      planFieldEdits(ITEM, {
        rename: [{ from: 'Application ID', to: 'Sandbox - Application ID' }],
        remove: ['linked'],
        set: [
          { name: 'environment', value: 'staging' },
          { name: 'Production - Application ID', value: '' },
          { name: 'note', value: 'plain', kind: 'text' },
        ],
      }),
    );
    expect(plan).toStrictEqual([
      { keep: ITEM[0], name: 'Sandbox - Application ID', kind: 'hidden' },
      { replaces: ITEM[1], name: 'environment', kind: 'text', value: 'staging' },
      { keep: ITEM[2], name: 'mfa', kind: 'boolean' },
      { name: 'Production - Application ID', kind: 'hidden', value: null },
      { name: 'note', kind: 'text', value: 'plain' },
    ]);
  });

  it('MCP-17 accepts a boolean value of true or false only', () => {
    expect(
      unwrapOk(planFieldEdits(ITEM, { set: [{ name: 'mfa', value: 'false' }] }))[2],
    ).toStrictEqual({
      replaces: ITEM[2],
      name: 'mfa',
      kind: 'boolean',
      value: 'false',
    });
    expect(refusal(ITEM, { set: [{ name: 'mfa', value: 'yes' }] })).toBe(
      "custom field 'mfa' is boolean: its value must be 'true' or 'false'",
    );
    expect(refusal(ITEM, { set: [{ name: 'new', value: '1', kind: 'boolean' }] })).toContain(
      'is boolean',
    );
  });

  it('MCP-17 refuses a field named by more than one change', () => {
    const message = "custom field 'mfa' is named by more than one change";
    expect(refusal(ITEM, { remove: ['mfa'], set: [{ name: 'mfa', value: 'true' }] })).toBe(message);
    expect(
      refusal(ITEM, {
        rename: [
          { from: 'mfa', to: 'x' },
          { from: 'y', to: 'mfa' },
        ],
      }),
    ).toBe(message);
    expect(refusal(ITEM, { remove: ['mfa', 'mfa'] })).toBe(message);
  });

  it('MCP-17 refuses to rename or remove a field the item does not have', () => {
    expect(refusal(ITEM, { remove: ['missing'] })).toBe(
      "the item has no custom field named 'missing'",
    );
    expect(refusal(ITEM, { rename: [{ from: 'missing', to: 'x' }] })).toBe(
      "the item has no custom field named 'missing'",
    );
  });

  it('MCP-17 refuses a name two fields share, for every kind of change', () => {
    const twice: readonly ExistingField[] = [...ITEM, { name: 'mfa', kind: 'text' }];
    const message = "the item has 2 custom fields named 'mfa'";
    expect(refusal(twice, { remove: ['mfa'] })).toBe(message);
    expect(refusal(twice, { rename: [{ from: 'mfa', to: 'x' }] })).toBe(message);
    expect(refusal(twice, { set: [{ name: 'mfa', value: 'true' }] })).toBe(message);
  });

  it('MCP-17 refuses a rename onto a name the item already has', () => {
    expect(refusal(ITEM, { rename: [{ from: 'mfa', to: 'environment' }] })).toBe(
      "the item already has a custom field named 'environment'",
    );
  });

  it('MCP-17 refuses to change a field’s kind, so a hidden value never turns visible', () => {
    expect(refusal(ITEM, { set: [{ name: 'Application ID', value: 'x', kind: 'text' }] })).toBe(
      "custom field 'Application ID' is hidden, not text; remove it and set it again to change its kind",
    );
  });

  it('MCP-17 refuses a value for a linked field', () => {
    expect(refusal(ITEM, { set: [{ name: 'linked', value: 'x' }] })).toBe(
      "custom field 'linked' is linked to another field and holds no value",
    );
  });

  it('MCP-17 applies nothing when a later change fails', () => {
    expect(
      refusal(ITEM, {
        remove: ['mfa'],
        rename: [{ from: 'environment', to: 'env' }],
        set: [{ name: 'linked', value: 'x' }],
      }),
    ).toContain('linked');
    expect(refusal(ITEM, { remove: ['mfa'], rename: [{ from: 'missing', to: 'x' }] })).toContain(
      'missing',
    );
  });
});
