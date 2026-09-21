import type { HeicTranscoder } from '@photoshare/core';

/**
 * HEIC → JPEG for Node using libheif (WASM) + jpeg-js. Pure JS, no native
 * build step, works everywhere Node runs. Slow-ish (~2–5 s for a 12 MP photo)
 * but keeps installation painless.
 */
export function nodeHeicTranscoder(quality = 92): HeicTranscoder {
  return async (heic: Uint8Array) => {
    const [{ default: mod }, jpeg] = await Promise.all([
      import('libheif-js/wasm-bundle.js') as Promise<{ default: LibHeif & { ready?: Promise<LibHeif> } }>,
      import('jpeg-js'),
    ]);
    const libheif = mod.ready ? await mod.ready : mod;
    const decoder = new libheif.HeifDecoder();
    const images = decoder.decode(heic);
    if (!images.length) throw new Error('HEIC: no image found');
    const image = images[0];
    const width = image.get_width();
    const height = image.get_height();
    const rgba = await new Promise<Uint8ClampedArray>((resolve, reject) => {
      image.display({ data: new Uint8ClampedArray(width * height * 4), width, height }, (out) => {
        if (!out) reject(new Error('HEIC: decode failed'));
        else resolve(out.data);
      });
    });
    const encoded = jpeg.encode({ data: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), width, height }, quality);
    return new Uint8Array(encoded.data.buffer, encoded.data.byteOffset, encoded.data.byteLength);
  };
}

interface LibHeif {
  HeifDecoder: new () => {
    decode(data: Uint8Array): HeifImage[];
  };
}
interface HeifImage {
  get_width(): number;
  get_height(): number;
  display(
    target: { data: Uint8ClampedArray; width: number; height: number },
    cb: (out: { data: Uint8ClampedArray; width: number; height: number } | null) => void,
  ): void;
}
