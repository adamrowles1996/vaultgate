/**
 * The whole templating layer: a tagged template that escapes every
 * interpolated string, and a document wrapper. No template engine, no
 * inline script, no inline style (ID-19).
 */
import { BRAND_MARK } from './icons.ts';

export interface Html {
  readonly markup: string;
}

type Value = string | number | Html | readonly Html[];

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function render(value: Value): string {
  if (typeof value === 'string') {
    return escapeHtml(value);
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return 'markup' in value ? value.markup : value.map((item) => item.markup).join('');
}

export function html(strings: TemplateStringsArray, ...values: readonly Value[]): Html {
  let markup = '';
  for (const [index, chunk] of strings.entries()) {
    markup += chunk;
    const value = values[index];
    if (value !== undefined) {
      markup += render(value);
    }
  }
  return { markup };
}

export const EMPTY: Html = { markup: '' };

export function when(isShown: boolean, content: () => Html): Html {
  return isShown ? content() : EMPTY;
}

/**
 * A page outside the console: setup, sign-in, recovery codes, consent and
 * the not-found page, each one card under the name. Console pages use
 * `consoleDocument` in `console.ts` instead.
 */
export function document(title: string, body: Html): string {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} · vaultgate</title>
        <link rel="stylesheet" href="/static/vaultgate.css" />
      </head>
      <body class="plain">
        <main class="plain-main">
          <h1 class="plain-brand">${BRAND_MARK}vaultgate</h1>
          <div class="plain-card">${body}</div>
        </main>
      </body>
    </html> `.markup;
}

export function errorBanner(message: string | undefined): Html {
  return message === undefined ? EMPTY : html`<p class="error" role="alert">${message}</p>`;
}

export function noticeBanner(message: string | undefined): Html {
  return message === undefined ? EMPTY : html`<p class="notice">${message}</p>`;
}

export function hidden(name: string, value: string): Html {
  return html`<input type="hidden" name="${name}" value="${value}" />`;
}

/**
 * A table's heading row. The stylesheet hides it on narrow screens and shows
 * each cell's `data-label` instead, so rows render as cards there; keep the
 * labels passed to `cell` identical to these headings.
 */
export function tableHead(columns: readonly string[]): Html {
  const headings = columns.map((column) => html`<th>${column}</th>`);
  return html`<thead>
    <tr>
      ${headings}
    </tr>
  </thead>`;
}

/**
A body cell labelled with its column heading (empty for an unlabelled column).
*/
export function cell(label: string, content: string | Html): Html {
  return html`<td data-label="${label}">${content}</td>`;
}
