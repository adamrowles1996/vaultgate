/**
 * The in-process access-token cache of ACT-82: one entry per target, keyed
 * by the target's id and valid only for the `revision` it was obtained
 * under, so editing the target's credential retires its token. The entry is
 * given up 60 s before `expires_in` elapses, so a token cannot expire
 * between the check and the request. Nothing here is written to disk and
 * nothing is logged; this is the one caching exception ACT-50 allows.
 */
export const TOKEN_MARGIN_MS = 60_000;

export interface CachedToken {
  readonly revision: number;
  readonly token: string;
  /**
  Milliseconds since the epoch at which `expires_in` elapses.
  */
  readonly expiresAt: number;
}

export interface TokenCache {
  get(targetId: string, revision: number, now: number): string | undefined;
  set(targetId: string, entry: CachedToken): void;
  invalidate(targetId: string): void;
}

export function createTokenCache(): TokenCache {
  const entries = new Map<string, CachedToken>();
  return {
    get(targetId, revision, now) {
      const entry = entries.get(targetId);
      if (entry === undefined) {
        return;
      }
      const isUsable = entry.revision === revision && now < entry.expiresAt - TOKEN_MARGIN_MS;
      if (!isUsable) {
        entries.delete(targetId);
      }
      return isUsable ? entry.token : undefined;
    },
    set(targetId, entry) {
      entries.set(targetId, entry);
    },
    invalidate(targetId) {
      entries.delete(targetId);
    },
  };
}
