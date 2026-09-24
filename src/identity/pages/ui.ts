/**
 * The console's shared building blocks (ID-19), drawn the same way by every
 * layer that serves a page: page headings, cards, status pills and tags,
 * the field chips, the hatched "sealed" chip that stands for every secret
 * field (a value is never drawn), and the monograms that stand for agents.
 * Like `template.ts` these escape every string they are given.
 */
import { createHash } from 'node:crypto';

import { icon, type IconName } from './icons.ts';
import { EMPTY, type Html, html, when } from './template.ts';

export type PillTone = 'ok' | 'bad' | 'warn' | 'off';
export type TagTone = 'plain' | 'amber' | 'green' | 'brass' | 'red';

/**
A page's heading block: the title, one sentence under it and, optionally, its actions.
*/
export function pageHead(title: string, intro: string | Html, actions: Html = EMPTY): Html {
  return html`<header class="page-head">
    <div>
      <h1>${title}</h1>
      <p class="intro">${intro}</p>
    </div>
    ${when(actions.markup.length > 0, () => html`<div class="page-actions">${actions}</div>`)}
  </header>`;
}

/**
A card's heading row: the heading, an optional sentence under it and optional actions beside it.
*/
export function cardHead(title: string, note?: string | Html, actions: Html = EMPTY): Html {
  return html`<div class="card-head">
    <div>
      <h2>${title}</h2>
      ${note === undefined ? EMPTY : html`<p class="card-note">${note}</p>`}
    </div>
    ${when(actions.markup.length > 0, () => html`<div class="card-actions">${actions}</div>`)}
  </div>`;
}

export function pill(tone: PillTone, text: string): Html {
  return html`<span class="pill pill-${tone}">${text}</span>`;
}

export function tag(text: string | Html, tone: TagTone = 'plain', name?: IconName): Html {
  return html`<span class="tag tag-${tone}"
    >${name === undefined ? EMPTY : icon(name)}${text}</span
  >`;
}

/**
A vault field's name, never its value.
*/
export function fieldChip(name: string): Html {
  return html`<span class="field-chip">${name}</span>`;
}

/**
 * A secret field as every page draws it: a hatched chip with its name and a
 * lock. There is deliberately no way to pass it a value.
 */
export function sealed(name = 'sealed'): Html {
  return html`<span class="sealed" title="Sealed: the value stays in the vault and is never shown"
    >${icon('lock')}${name}</span
  >`;
}

const TONE_COUNT = 4;

/**
The same agent always gets the same colour: a small, stable hash of its id picks one of four.
*/
export function toneOf(id: string): number {
  return createHash('sha256').update(id).digest().readUInt8(0) % TONE_COUNT;
}

function initialsOf(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
  const letters =
    words.length > 1
      ? words
          .slice(0, 2)
          .map((word) => word.slice(0, 1))
          .join('')
      : name.slice(0, 2);
  return letters.length === 0 ? '?' : letters.toUpperCase();
}

/**
An agent's monogram: its initials in its colour, with the full name as the tooltip.
*/
export function monogram(id: string, name: string, size: 'small' | 'large' = 'small'): Html {
  const large = size === 'large' ? ' large' : '';
  return html`<span class="monogram tone-${toneOf(id)}${large}" title="${name}"
    >${initialsOf(name)}</span
  >`;
}

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const DAYS_SHOWN = 30;

/**
How long ago `at` was, in words an operator reads at a glance; a date after a month.
*/
export function relativeTime(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / MS_PER_MINUTE);
  if (minutes < 1) {
    return 'just now';
  }
  if (minutes < MINUTES_PER_HOUR) {
    return `${String(minutes)} min ago`;
  }
  const hours = Math.floor(minutes / MINUTES_PER_HOUR);
  if (hours < HOURS_PER_DAY) {
    return `${String(hours)} h ago`;
  }
  const days = Math.floor(hours / HOURS_PER_DAY);
  if (days < DAYS_SHOWN) {
    return days === 1 ? 'yesterday' : `${String(days)} days ago`;
  }
  return new Date(at).toISOString().slice(0, 10);
}

/**
An instant as an operator reads it, always in UTC: `2026-09-22 11:00 UTC`.
*/
export function formatInstant(at: number): string {
  const iso = new Date(at).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}
