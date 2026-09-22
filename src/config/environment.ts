/**
The process environment as seen by configuration loading.
*/
export type Environment = Readonly<Record<string, string | undefined>>;

/**
 * Drops empty values so `VAULTGATE_BW_SERVER=` in a Compose file means
 * "unset" rather than "the empty string".
 */
export function withoutEmptyValues(environment: Environment): Environment {
  return Object.fromEntries(
    Object.entries(environment).filter(([, value]) => value !== undefined && value !== ''),
  );
}
