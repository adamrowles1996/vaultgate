/**
 * The vault secrets held for the life of the process (VAULT-15). The master
 * password and API client secret live in Buffers so shutdown can overwrite
 * them; strings are immutable and would linger until collected. The object
 * has no enumerable secret properties and no `toJSON`, so an accidental
 * serialisation yields nothing.
 */
export class Credentials {
  readonly #masterPassword: Buffer;
  readonly #clientSecret: Buffer;
  #disposed = false;
  readonly clientId: string;

  constructor(clientId: string, masterPassword: string, clientSecret: string) {
    this.clientId = clientId;
    this.#masterPassword = Buffer.from(masterPassword, 'utf8');
    this.#clientSecret = Buffer.from(clientSecret, 'utf8');
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
