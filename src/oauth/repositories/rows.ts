import { z } from 'zod';

/**
 * Column codecs shared by the OAuth repositories (schema conventions in
 * `storage/migrations/001-initial.ts`): JSON columns are TEXT, timestamps
 * are INTEGER milliseconds, absent values are NULL and surface as `undefined`.
 */
export const jsonStringArray = z
  .string()
  .transform((text): readonly string[] => z.array(z.string()).parse(JSON.parse(text)));

export const jsonObject = z
  .string()
  .transform((text): Readonly<Record<string, unknown>> =>
    z.record(z.string(), z.unknown()).parse(JSON.parse(text)),
  );

export const jsonStringRecord = z
  .string()
  .transform((text): Readonly<Record<string, string>> =>
    z.record(z.string(), z.string()).parse(JSON.parse(text)),
  );

export const optionalText = z
  .string()
  .nullable()
  .transform((value) => value ?? undefined);

export const optionalTimestamp = z
  .number()
  .nullable()
  .transform((value) => value ?? undefined);

export const timestamp = z.number();
