/**
 * The single static stylesheet (ID-19), served from `/static/vaultgate.css`:
 * the design tokens, element defaults, the console and sign-in frames, the
 * building blocks, vault items, and the narrow-screen rules last so they win.
 */
import { BASE } from './styles/base.ts';
import { COMPONENTS } from './styles/components.ts';
import { CONTROLS } from './styles/controls.ts';
import { FRAME } from './styles/frame.ts';
import { ITEMS } from './styles/items.ts';
import { COMPUTERS, LAYOUT } from './styles/layout.ts';
import { RESPONSIVE } from './styles/responsive.ts';
import { SHELL } from './styles/shell.ts';
import { TOKENS } from './styles/tokens.ts';

export const STYLESHEET = [
  TOKENS,
  BASE,
  SHELL,
  FRAME,
  COMPONENTS,
  CONTROLS,
  LAYOUT,
  COMPUTERS,
  ITEMS,
  RESPONSIVE,
].join('');
