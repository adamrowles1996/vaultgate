/**
 * The one version source: `package.json` next to the source tree or the
 * build (`dist/` mirrors `src/`, and the image and the release tarball ship
 * the manifest beside it). Reported in MCP `initialize` and sent as the
 * `User-Agent` of every actions request (ACT-80).
 */
import { readFileSync } from 'node:fs';

import { z } from 'zod';

const manifestSchema = z.object({ version: z.string().min(1) });

function readVersion(): string {
  const text = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const manifest: unknown = JSON.parse(text);
  return manifestSchema.parse(manifest).version;
}

export const VERSION: string = readVersion();
