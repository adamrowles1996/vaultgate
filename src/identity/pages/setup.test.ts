import { describe, expect, it } from 'vitest';

import { enrolmentImageOf, enrolmentQrUriOf } from '../../test-support/enrolment-qr.ts';
import { describeEnrolment } from '../totp.ts';

import { renderEnrolmentDetails } from './setup.ts';

const SECRET = Buffer.from('12345678901234567890');

describe('enrolment QR', () => {
  it.each([undefined, 'ada+test@example.com', `${'a'.repeat(240)}@example.com`])(
    'ID-9 encodes the exact URI for %s, with an opaque white four-module quiet zone',
    (account) => {
      const enrolment = describeEnrolment(account, SECRET);
      const { markup } = renderEnrolmentDetails(enrolment);
      expect(enrolmentQrUriOf(markup)).toBe(enrolment.uri);
      const image = enrolmentImageOf(markup);
      expect(image.width).toBe(image.height);
      expect(image.width % 4).toBe(0);
      expect(image.width).toBeGreaterThanOrEqual(200);
      const rowBytes = image.width * 4;
      expect([...image.data.slice(0, rowBytes * 16)].every((byte) => byte === 255)).toBe(true);
      expect([...image.data.slice(-rowBytes * 16)].every((byte) => byte === 255)).toBe(true);
      for (let row = 0; row < image.height; row += 1) {
        const pixels = image.data.slice(row * rowBytes, (row + 1) * rowBytes);
        expect(
          [...pixels.slice(0, 16 * 4), ...pixels.slice(-16 * 4)].every((byte) => byte === 255),
        ).toBe(true);
      }
      expect(markup).toContain('alt="Scan to add vaultgate to your authenticator"');
      expect(markup).toContain(`<code>${enrolment.secretBase32}</code>`);
    },
  );

  it('ID-9 retains both text fallbacks when a label exceeds QR capacity', () => {
    const enrolment = describeEnrolment('a'.repeat(4000), SECRET);
    const { markup } = renderEnrolmentDetails(enrolment);
    expect(markup).not.toContain('data:image/');
    expect(markup).toContain(`<code>${enrolment.secretBase32}</code>`);
    expect(markup).toContain(enrolment.uri.replaceAll('&', '&amp;'));
  });

  it('ID-19 escapes the text fallbacks and never inserts the URI as markup', () => {
    const { markup } = renderEnrolmentDetails({ secretBase32: '<key>', uri: '<script>&"' });
    expect(enrolmentQrUriOf(markup)).toBe('<script>&"');
    expect(markup).toContain('&lt;key&gt;');
    expect(markup).toContain('&lt;script&gt;&amp;&quot;');
    expect(markup).not.toContain('<script>');
  });
});
