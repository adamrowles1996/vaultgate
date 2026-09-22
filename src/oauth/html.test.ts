import { describe, expect, it } from 'vitest';

import { escapeHtml, HTML_CONTENT_SECURITY_POLICY, HTML_HEADERS, htmlDocument } from './html.ts';

describe('escapeHtml', () => {
  it('escapes every HTML special character', () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      '&lt;a href=&#34;x&#34;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;',
    );
  });
});

describe('htmlDocument', () => {
  it('ID-19 links the single static stylesheet and contains no script', () => {
    const page = htmlDocument('Title <1>', '<p>body</p>');
    expect(page).toContain('<title>Title &lt;1&gt;</title>');
    expect(page).toContain('<link rel="stylesheet" href="/static/vaultgate.css">');
    expect(page).toContain('<main><p>body</p></main>');
    expect(page).not.toContain('<script');
  });

  it('ID-19 headers carry the policy and forbid caching', () => {
    expect(HTML_HEADERS).toStrictEqual({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': HTML_CONTENT_SECURITY_POLICY,
      'Cache-Control': 'no-store',
    });
    expect(HTML_CONTENT_SECURITY_POLICY).toBe(
      "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
  });
});
