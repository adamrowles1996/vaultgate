import { GifReader } from 'omggif';
import { decodeQR } from 'qr/decode.js';

/**
Rasterise the embedded image itself, not a second encoding of the URI.
*/
export function enrolmentImageOf(markup: string): {
  width: number;
  height: number;
  data: Uint8Array;
} {
  const encoded = /src="data:image\/gif;base64,([^"]+)"/.exec(markup)?.[1];
  if (encoded === undefined) {
    throw new Error('missing embedded enrolment QR');
  }
  const reader = new GifReader(Buffer.from(encoded, 'base64'));
  const data = new Uint8Array(reader.width * reader.height * 4);
  reader.decodeAndBlitFrameRGBA(0, data);
  return { width: reader.width, height: reader.height, data };
}

export function enrolmentQrUriOf(markup: string): string {
  return decodeQR(enrolmentImageOf(markup));
}
