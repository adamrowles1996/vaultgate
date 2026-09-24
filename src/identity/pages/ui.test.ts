import { describe, expect, it } from 'vitest';

import { compact } from '../../test-support/identity-app.ts';

import { shortVersion } from './console.ts';
import { html } from './template.ts';
import {
  cardHead,
  fieldChip,
  formatInstant,
  monogram,
  pageHead,
  relativeTime,
  sealed,
  tag,
  toneOf,
} from './ui.ts';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const MINUTE = 60_000;

describe('the console building blocks', () => {
  it('ID-19 says how long ago something was in words, then as a date after a month', () => {
    expect(relativeTime(NOW - 20_000, NOW)).toBe('just now');
    expect(relativeTime(NOW + 5000, NOW)).toBe('just now');
    expect(relativeTime(NOW - 4 * MINUTE, NOW)).toBe('4 min ago');
    expect(relativeTime(NOW - 125 * MINUTE, NOW)).toBe('2 h ago');
    expect(relativeTime(NOW - 25 * 60 * MINUTE, NOW)).toBe('yesterday');
    expect(relativeTime(NOW - 3 * 24 * 60 * MINUTE, NOW)).toBe('3 days ago');
    expect(relativeTime(NOW - 40 * 24 * 60 * MINUTE, NOW)).toBe('2026-08-15');
    expect(formatInstant(NOW)).toBe('2026-09-24 12:00 UTC');
  });

  it('ID-19 gives every agent a stable colour and its initials', () => {
    expect(toneOf('vg_c_agent')).toBe(toneOf('vg_c_agent'));
    const tones = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => toneOf(id));
    expect(new Set(tones).size).toBeGreaterThan(1);
    expect(tones.every((tone) => tone >= 0 && tone < 4)).toBe(true);
    expect(monogram('x', 'Claude Code').markup).toContain('>CC</span');
    expect(monogram('x', 'desk').markup).toContain('>DE</span');
    expect(monogram('x', '').markup).toContain('>?</span');
    expect(monogram('x', 'Big Agent', 'large').markup).toContain('class="monogram tone-');
    expect(monogram('x', 'Big Agent', 'large').markup).toContain(' large"');
  });

  it('ID-19 draws a secret field sealed, by name only, and a plain field as a chip', () => {
    expect(compact(sealed('password').markup)).toContain('</svg>password</span>');
    expect(sealed().markup).toContain('sealed</span');
    expect(fieldChip('login.username').markup).toBe(
      '<span class="field-chip">login.username</span>',
    );
  });

  it('ID-19 shows a pre-release by its tag and a release by its number', () => {
    expect(shortVersion('0.1.0-rc.14')).toBe('rc.14');
    expect(shortVersion('1.2.0')).toBe('1.2.0');
  });

  it('ID-19 heads pages and cards, with actions only when there are some', () => {
    const plain = pageHead('Title', 'One line.').markup;
    expect(plain).toContain('<h1>Title</h1>');
    expect(plain).not.toContain('page-actions');
    const withActions = pageHead('Title', 'One line.', html`<a href="/x">Go</a>`).markup;
    expect(withActions).toContain('<div class="page-actions"><a href="/x">Go</a></div>');
    expect(cardHead('Card').markup).not.toContain('card-note');
    expect(cardHead('Card', 'Note', html`<b>act</b>`).markup).toContain(
      '<div class="card-actions"><b>act</b></div>',
    );
    expect(compact(tag('Reads only').markup)).toBe('<span class="tag tag-plain">Reads only</span>');
    expect(tag('ok', 'green', 'check').markup).toContain('<svg class="icon"');
  });
});
