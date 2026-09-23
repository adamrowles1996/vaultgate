import { document, html } from './template.ts';

/**
The page a browser sees for an unknown path (ID-24); same template and stylesheet as the rest.
*/
export function renderNotFound(): string {
  return document(
    'Not found',
    html`<h2>Page not found</h2>
      <p>There is nothing at this address.</p>
      <p><a href="/">Go to the start</a></p>`,
  );
}
