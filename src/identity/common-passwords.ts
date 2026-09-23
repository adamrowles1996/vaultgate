import { gunzipSync } from 'node:zlib';

import { COMMON_PASSWORDS_ARCHIVE } from './common-passwords-data.ts';

const holder: { entries?: ReadonlySet<string> } = {};

function load(): ReadonlySet<string> {
  const archive = Buffer.from(COMMON_PASSWORDS_ARCHIVE.join(''), 'base64');
  const entries = gunzipSync(archive)
    .toString('utf8')
    .split('\n')
    .filter((entry) => entry.length > 0);
  return new Set(entries.map((entry) => entry.toLowerCase()));
}

/**
 * True when the text is on the bundled list of the most common passwords
 * (ID-5). The comparison ignores case; the list is decoded on first use.
 */
export function isCommonPassword(text: string): boolean {
  holder.entries ??= load();
  return holder.entries.has(text.toLowerCase());
}
