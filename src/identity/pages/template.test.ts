import { describe, expect, it } from 'vitest';

// Aliased: Prettier reformats `tag` tagged templates, and this test asserts exact markup.
import {
  document,
  EMPTY,
  errorBanner,
  escapeHtml,
  hidden,
  html as tag,
  noticeBanner,
  when,
} from './template.ts';

describe('template', () => {
  it('ID-19 escapes interpolated text and passes nested markup through', () => {
    const items = ['<b>', 'x'].map((item) => tag`<li>${item}</li>`);
    const title = '"quoted" & \'single\'';
    const result = tag`<ul title="${title}">${items}</ul>${3}${EMPTY}`;
    expect(result.markup).toBe(
      '<ul title="&quot;quoted&quot; &amp; &#39;single&#39;"><li>&lt;b&gt;</li><li>x</li></ul>3',
    );
    expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
  });

  it('ID-19 renders a full document without any script', () => {
    const page = document('Title <1>', tag`<p>body</p>`);
    expect(page).toContain('<title>Title &lt;1&gt; · vaultgate</title>');
    expect(page).toContain('<link rel="stylesheet" href="/static/vaultgate.css" />');
    expect(page).toContain('<p>body</p>');
    expect(page).not.toContain('<script');
  });

  it('ID-19 renders optional fragments', () => {
    expect(when(true, () => tag`<i>yes</i>`).markup).toBe('<i>yes</i>');
    expect(when(false, () => tag`<i>yes</i>`)).toBe(EMPTY);
    expect(errorBanner(undefined)).toBe(EMPTY);
    expect(noticeBanner(undefined)).toBe(EMPTY);
    expect(noticeBanner('<done>').markup).toBe('<p class="notice">&lt;done&gt;</p>');
    expect(errorBanner('bad & worse').markup).toBe(
      '<p class="error" role="alert">bad &amp; worse</p>',
    );
    expect(hidden('csrf', 'a"b').markup).toBe(
      '<input type="hidden" name="csrf" value="a&quot;b" />',
    );
  });
});
