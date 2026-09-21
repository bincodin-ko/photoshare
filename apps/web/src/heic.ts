import type { HeicTranscoder } from '@photoshare/core';

/**
 * Browser HEIC → JPEG. Safari can decode HEIC natively; everywhere else we use
 * libheif compiled to WebAssembly (loaded lazily, only when a HEIC shows up).
 */
export const browserHeicTranscoder: HeicTranscoder = async (heic) => {
  const bitmap = (await nativeDecode(heic)) ?? (await wasmDecode(heic));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  if (bitmap instanceof ImageBitmap) ctx.drawImage(bitmap, 0, 0);
  else ctx.putImageData(bitmap, 0, 0);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) throw new Error('JPEG 인코딩에 실패했습니다');
  return new Uint8Array(await blob.arrayBuffer());
};

async function nativeDecode(heic: Uint8Array): Promise<ImageBitmap | undefined> {
  try {
    return await createImageBitmap(new Blob([new Uint8Array(heic)], { type: 'image/heic' }));
  } catch {
    return undefined;
  }
}

interface HeifImage {
  get_width(): number;
  get_height(): number;
  display(target: ImageData, cb: (out: ImageData | null) => void): void;
}
interface LibHeif {
  HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[] };
}

let libheifPromise: Promise<LibHeif> | undefined;

async function wasmDecode(heic: Uint8Array): Promise<ImageData> {
  // The ESM bundle's default export is an Emscripten factory; the module it returns
  // exposes `ready` while the (embedded) wasm is still being instantiated.
  libheifPromise ??= import('libheif-js/libheif-wasm/libheif-bundle.mjs').then(async (m) => {
    const factory = m.default as () => LibHeif & { ready?: Promise<LibHeif> };
    const mod = factory();
    return mod.ready ? await mod.ready : mod;
  });
  const libheif = await libheifPromise;
  const images = new libheif.HeifDecoder().decode(heic);
  if (!images.length) throw new Error('HEIC 안에서 이미지를 찾지 못했습니다');
  const img = images[0];
  const w = img.get_width();
  const h = img.get_height();
  return new Promise<ImageData>((resolve, reject) => {
    img.display(new ImageData(w, h), (out) => (out ? resolve(out) : reject(new Error('HEIC 디코딩 실패'))));
  });
}
