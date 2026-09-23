/**
 * One generation of vault secrets (VAULT-15). The master password and API
 * client secret live in Buffers so the supervisor can overwrite them when the
 * generation is retired; strings are immutable and would linger until
 * collected. The object has no enumerable secret properties and no `toJSON`,
 * so an accidental serialisation yields nothing.
 */
export interface CredentialValues {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly masterPassword: string;
  /**
  `bitwarden.eu` or an `https://` URL; `undefined` is the bitwarden.com default.
  */
  readonly server: string | undefined;
}

export class Credentials {
  readonly #masterPassword: Buffer;
  readonly #clientSecret: Buffer;
  #disposed = false;
  readonly clientId: string;
  readonly server: string | undefined;

  constructor(values: CredentialValues) {
    this.clientId = values.clientId;
    this.server = values.server;
    this.#masterPassword = Buffer.from(values.masterPassword, 'utf8');
    this.#clientSecret = Buffer.from(values.clientSecret, 'utf8');
  }

  #read(buffer: Buffer): string {
    if (this.#disposed) {
      throw new Error('credentials have been disposed');
    }
    return buffer.toString('utf8');
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  masterPassword(): string {
    return this.#read(this.#masterPassword);
  }

  clientSecret(): string {
    return this.#read(this.#clientSecret);
  }

  /**
  Zero-fills both secrets. Reading afterwards is a programmer error and throws.
  */
  dispose(): void {
    this.#masterPassword.fill(0);
    this.#clientSecret.fill(0);
    this.#disposed = true;
  }
}
