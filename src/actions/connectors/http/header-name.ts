/**
 * An HTTP header name as a target document holds it (ACT-22, ACT-34): RFC
 * 9110 token characters, lower-cased so every comparison with a name an
 * agent sends is case-insensitive. The `http` policy's header lists, the
 * `header` mode's `name` (ACT-79) and the `oauth2` mode's `name` (ACT-124)
 * share it.
 */
import { z } from 'zod';

export const headerNameSchema = z
  .string()
  .regex(/^[\w!#$%&'*+.^`|~-]+$/, 'must be an HTTP header name')
  .transform((name) => name.toLowerCase());
