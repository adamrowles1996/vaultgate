import { describe, expect, it } from 'vitest';

import { STYLESHEET } from './stylesheet.ts';

function rulesOf(block: string): string {
  const start = STYLESHEET.indexOf(block);
  expect(start).toBeGreaterThanOrEqual(0);
  return STYLESHEET.slice(start);
}

describe('stylesheet', () => {
  it('ID-19 stacks tables into labelled cards on narrow screens', () => {
    const narrow = rulesOf('@media (max-width: 640px) {');
    expect(narrow).toContain('display: block;');
    expect(narrow).toContain('clip-path: inset(50%);');
    expect(narrow).toContain('content: attr(data-label);');
    expect(narrow).toContain('display: flex;');
    expect(narrow).toContain("td[data-label='']::before {\n    content: none;");
    expect(narrow).toContain('td button {\n    width: 100%;');
  });

  it('ID-19 fixes the causes of horizontal overflow instead of hiding it', () => {
    expect(STYLESHEET).not.toContain('overflow-x: hidden');
    expect(STYLESHEET).toContain('main {\n  min-width: 0;');
    expect(STYLESHEET).toContain('max-width: 100%;');
    expect(STYLESHEET).toContain('overflow-wrap: anywhere;');
    expect(STYLESHEET).toContain('white-space: pre-wrap;');
  });

  it('ID-19 keeps inputs at the base size and gives touch screens 44px targets', () => {
    expect(STYLESHEET).toContain(':root {\n  font-size: 100%;');
    expect(STYLESHEET).toContain('select {\n  font: inherit;');
    const touch = rulesOf('@media (max-width: 640px), (pointer: coarse) {');
    expect(touch).toContain('min-height: 44px;');
  });
});
