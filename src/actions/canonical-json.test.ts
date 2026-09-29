import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical-json.ts';

describe('canonicalJson', () => {
  it('ACT-7 sorts object keys at every level, keeps array order, drops undefined and serialises scalars as JSON', () => {
    expect(
      canonicalJson({ b: [3, { z: 1, y: null }], a: 'x', c: undefined, d: true, e: 1.5 }),
    ).toBe('{"a":"x","b":[3,{"y":null,"z":1}],"d":true,"e":1.5}');
    expect(canonicalJson('ü"')).toBe(String.raw`"ü\""`);
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({})).toBe('{}');
  });

  it('ACT-7 gives two documents that differ only in key order the same text', () => {
    expect(canonicalJson({ path: '/x', method: 'POST' })).toBe(
      canonicalJson({ method: 'POST', path: '/x' }),
    );
    expect(canonicalJson({ method: 'POST', path: '/y' })).not.toBe(
      canonicalJson({ method: 'POST', path: '/x' }),
    );
  });
});
