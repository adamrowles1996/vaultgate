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
    expect(STYLESHEET).toContain('input,\nselect,\ntextarea,\nbutton {\n  font: inherit;');
    const touch = rulesOf('@media (max-width: 640px), (pointer: coarse) {');
    expect(touch).toContain('min-height: 44px;');
  });

  it('ID-19 folds the console’s sidebar into a bar across the top on a narrow screen', () => {
    const console = rulesOf('@media (max-width: 960px) {');
    expect(console).toContain('.shell {\n    grid-template-columns: minmax(0, 1fr);');
    expect(console).toContain('.nav .nav-sub {\n    display: none;');
  });

  it('ID-19 follows the system’s dark setting and colours every kind of computer', () => {
    expect(rulesOf('@media (prefers-color-scheme: dark) {')).toContain('--bg: #0f1114;');
    for (const kind of ['mssql', 'postgres', 'winrm', 'ssh', 'http', 'graph', 'code']) {
      expect(STYLESHEET).toContain(`.kind-tile.kind-${kind} {`);
      expect(STYLESHEET).toContain(`.kind-dot.kind-${kind},`);
    }
    expect(STYLESHEET).toContain('.monogram.tone-3 {');
  });

  it('ID-19 loads nothing of its own: no web font, no image and no other stylesheet', () => {
    expect(STYLESHEET).not.toContain('url(');
    expect(STYLESHEET).not.toContain('@import');
    expect(STYLESHEET).not.toContain('@font-face');
  });
});
