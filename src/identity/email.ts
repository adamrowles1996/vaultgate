import { fail, ok, type Result } from '../result.ts';

/**
RFC 5321 §4.5.3.1.3: a path (the whole address) is at most 254 characters.
*/
const MAX_EMAIL_LENGTH = 254;
const SPACE_OR_CONTROL = /[\s\p{Cc}]/u;

export const EMAIL_ERROR = 'enter a valid e-mail address';

/**
 * Trims, lower-cases and shape-checks an address (ID-3): one `@`, a
 * non-empty local part, a domain with a dot that is neither first nor last,
 * no whitespace or control characters and at most 254 characters. Nothing is
 * resolved or delivered; the address is a login identifier, not a verified
 * contact.
 */
export function normaliseEmail(raw: string): Result<string> {
  const email = raw.trim().toLowerCase();
  const at = email.indexOf('@');
  const domain = email.slice(at + 1);
  const dot = domain.indexOf('.');
  const isShaped =
    email.length <= MAX_EMAIL_LENGTH &&
    at > 0 &&
    at === email.lastIndexOf('@') &&
    dot > 0 &&
    dot < domain.length - 1 &&
    !SPACE_OR_CONTROL.test(email);
  return isShaped ? ok(email) : fail(new Error(EMAIL_ERROR));
}
