/**
 * ID-19: every HTML page vaultgate serves carries this policy and no script.
 */
export const HTML_CONTENT_SECURITY_POLICY =
  "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

export const STYLESHEET_PATH = '/static/vaultgate.css';

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replaceAll(/["&'<>]/g, (character) => ESCAPES[character] ?? character);
}

export function htmlDocument(title: string, body: string): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<link rel="stylesheet" href="${STYLESHEET_PATH}">`,
    '</head>',
    `<body><main>${body}</main></body>`,
    '</html>',
  ].join('\n');
}

export const HTML_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': HTML_CONTENT_SECURITY_POLICY,
  'Cache-Control': 'no-store',
};
