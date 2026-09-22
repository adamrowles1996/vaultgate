import { z } from 'zod';

import { MS_PER_MINUTE } from './primitives.ts';

import type { SecretBox } from './secret-box.ts';

export const STATE_TTL_MS = 10 * MS_PER_MINUTE;

const stateSchema = z.object({
  csrfToken: z.string().min(1),
  expiresAt: z.number().int(),
  setupSecret: z.string().optional(),
  passwordVerifiedOperatorId: z.string().optional(),
  pendingTotpSecret: z.string().optional(),
});

/**
 * Short-lived browser state carried across the multi-step forms, sealed in
 * the state cookie: a synchroniser token for anonymous forms, the TOTP
 * secret being enrolled (base64) and, mid-login, which operator has passed
 * the password step. Nothing here is stored server-side.
 */
export type BrowserState = z.output<typeof stateSchema>;

export interface StateCodec {
  encode(state: BrowserState): string;
  /**
  The state, or `undefined` when the cookie is missing, forged, malformed or expired.
  */
  decode(value: string | undefined, now: number): BrowserState | undefined;
}

export function createStateCodec(box: SecretBox): StateCodec {
  return {
    encode: (state) => box.seal(Buffer.from(JSON.stringify(state), 'utf8')),
    decode: (value, now) => {
      const opened = value === undefined ? undefined : box.open(value);
      if (opened === undefined) {
        return;
      }
      const parsed = stateSchema.safeParse(JSON.parse(opened.toString('utf8')));
      return parsed.success && parsed.data.expiresAt > now ? parsed.data : undefined;
    },
  };
}
