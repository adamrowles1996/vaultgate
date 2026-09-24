/**
 * The console's icons (ID-19): inline SVG outlines the stylesheet strokes,
 * so a page needs no image request and nothing for the policy to allow.
 * Every icon is decorative (`aria-hidden`); the text beside it, or the
 * control's `aria-label`, carries the meaning. The paths are fixed strings,
 * never built from input. The return type is the template's `Html` by shape,
 * so the template can draw the mark without an import cycle.
 */
interface Markup {
  readonly markup: string;
}

const PATHS = {
  activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
  alert: '<path d="M12 3.5 2.5 20h19z"/><path d="M12 10v4.5M12 17.5h.01"/>',
  'arrow-left': '<path d="M19 12H5M11 6l-6 6 6 6"/>',
  'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4M9 13.5h.01M15 13.5h.01M9.5 17h5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  database:
    '<ellipse cx="12" cy="5.5" rx="7.5" ry="2.8"/><path d="M4.5 5.5v13c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8v-13"/><path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  external:
    '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  globe:
    '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.4 2.6 3.6 5.6 3.6 9s-1.2 6.4-3.6 9c-2.4-2.6-3.6-5.6-3.6-9S9.6 5.6 12 3z"/>',
  graph:
    '<circle cx="6" cy="7" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.4 6.8l7.1-.6M7.2 9.2l3.6 6.6M16.9 8.3l-3.7 7.4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M16.5 6.5l2.5 2.5M14 9l2 2"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  'log-out':
    '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  network:
    '<rect x="9" y="3" width="6" height="5" rx="1"/><rect x="3" y="16" width="6" height="5" rx="1"/><rect x="15" y="16" width="6" height="5" rx="1"/><path d="M12 8v4M6 16v-2h12v2"/>',
  pause:
    '<rect x="7" y="5" width="3.5" height="14" rx="1"/><rect x="13.5" y="5" width="3.5" height="14" rx="1"/>',
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  play: '<path d="M7 5v14l12-7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  refresh:
    '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16"/><path d="M20 20v-4h-4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  server:
    '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7.5 7.5h.01M7.5 16.5h.01"/>',
  shield:
    '<path d="M12 3 5 6v5.5c0 4.6 3 8.1 7 9.5 4-1.4 7-4.9 7-9.5V6z"/><path d="m9 12 2.2 2.2L15.5 10"/>',
  terminal:
    '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7.5 9.5 3 2.5-3 2.5M13 15h4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.6-1.7"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.4-3.6 4.2-5.5 7.5-5.5s6.1 1.9 7.5 5.5"/>',
  vault:
    '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="4"/><path d="M12 8v1.5M12 14.5V16M8 12h1.5M14.5 12H16"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
} as const;

export type IconName = keyof typeof PATHS;

/**
One decorative icon, sized and stroked by the stylesheet's `.icon` rule.
*/
export function icon(name: IconName): Markup {
  return {
    markup: `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`,
  };
}

/**
The mark beside the name in the sidebar and above the sign-in card: a gate with a keyhole.
*/
export const BRAND_MARK: Markup = {
  markup:
    '<svg class="brand-mark" viewBox="0 0 30 30" aria-hidden="true" focusable="false">' +
    '<rect width="30" height="30" rx="8"/>' +
    '<path d="M9 23.5v-10a6 6 0 0 1 12 0v10"/><circle cx="15" cy="14.2" r="2.3"/><path d="M15 16v3.8"/>' +
    '</svg>',
};
