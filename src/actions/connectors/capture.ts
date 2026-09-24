/**
 * Bytes from one output stream, kept to the limit (ACT-52): the connector
 * collects `max_output_bytes` plus the scrubber's guard band, and anything
 * beyond that is dropped and reported as truncated. `ssh` fills one of these
 * per channel stream, `winrm` one per `Receive` stream; the engine scrubs and
 * cuts again at the limit itself.
 */
export class Capture {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  #isTruncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  add(chunk: Buffer): void {
    const room = this.#limit - this.#bytes;
    if (room <= 0) {
      this.#isTruncated = true;
      return;
    }
    const fitted = chunk.subarray(0, room);
    this.#chunks.push(fitted);
    this.#bytes += fitted.length;
    this.#isTruncated ||= fitted.length < chunk.length;
  }

  get bytes(): Buffer {
    return Buffer.concat(this.#chunks);
  }

  get isTruncated(): boolean {
    return this.#isTruncated;
  }
}
