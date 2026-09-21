import { ByteWriter, FormatError, ascii, concat, decodeLatin1, startsWith, u16, u32 } from '../bytes.js';

/**
 * Samsung Extended Format (SEF) trailer — how Samsung Gallery finds the video
 * in a Motion Photo. Layout (all little-endian), appended after the JPEG EOI:
 *
 *   block*   := u16 0 | u16 type | u32 nameLen | name | data
 *   dir      := "SEFH" | u32 version (106) | u32 count | entry*count
 *   entry    := u16 0 | u16 type | u32 negOffset (dirStart - blockStart) | u32 blockSize
 *   tail     := u32 dirLen | "SEFT"
 *
 * Reverse-engineered by the exiftool project (Samsung.pm) and cross-checked
 * against exiftool's reader in this repo's tests.
 */

export const SEF_TYPE = {
  ImageUtcData: 0x0a01,
  MotionPhotoData: 0x0a30,
  MotionPhotoVersion: 0x0a31,
  MotionPhotoAutoPlay: 0x0a33,
  MccData: 0x0aa1,
} as const;

export interface SefBlock {
  type: number;
  name: string;
  data: Uint8Array;
  /** Absolute offset of the data bytes inside the file that was parsed (when known). */
  dataOffset?: number;
}

export interface SefTrailer {
  version: number;
  blocks: SefBlock[];
  /** Absolute offset where the trailer (first block) starts. */
  start: number;
  /** Absolute offset of the SEFH directory. */
  dirStart: number;
}

const SEFT = ascii('SEFT');
const SEFH = ascii('SEFH');

/** Parse the SEF trailer at the very end of `file`, if any. */
export function parseSefTrailer(file: Uint8Array): SefTrailer | undefined {
  const n = file.byteLength;
  if (n < 8 + 12) return undefined;
  if (!startsWith(file, SEFT, n - 4)) return undefined;
  const dirLen = u32(file, n - 8, true);
  const dirStart = n - 8 - dirLen;
  if (dirLen < 12 || dirStart < 0 || !startsWith(file, SEFH, dirStart)) return undefined;
  const version = u32(file, dirStart + 4, true);
  const count = u32(file, dirStart + 8, true);
  if (12 + 12 * count > dirLen) return undefined;
  const blocks: SefBlock[] = [];
  let start = dirStart;
  for (let i = 0; i < count; i++) {
    const e = dirStart + 12 + 12 * i;
    const type = u16(file, e + 2, true);
    const negOff = u32(file, e + 4, true);
    const size = u32(file, e + 8, true);
    const blockStart = dirStart - negOff;
    if (blockStart < 0 || size < 8 || blockStart + size > dirStart) continue;
    const nameLen = u32(file, blockStart + 4, true);
    if (8 + nameLen > size) continue;
    const name = decodeLatin1(file.subarray(blockStart + 8, blockStart + 8 + nameLen));
    const dataOffset = blockStart + 8 + nameLen;
    blocks.push({ type, name, data: file.subarray(dataOffset, blockStart + size), dataOffset });
    if (blockStart < start) start = blockStart;
  }
  return { version, blocks, start, dirStart };
}

export function encodeSefBlock(b: SefBlock): Uint8Array {
  const name = ascii(b.name);
  const w = new ByteWriter(16 + name.byteLength);
  w.u16(0, true).u16(b.type, true).u32(name.byteLength, true).bytes(name);
  return concat([w.toUint8Array(), b.data]);
}

/** Header size (before the data bytes) of a SEF block with this name. */
export function sefBlockHeaderSize(name: string): number {
  return 8 + name.length;
}

/**
 * Serialise a complete SEF trailer (blocks + directory + tail).
 * Blocks are written in the given order; the directory references them.
 */
export function buildSefTrailer(blocks: SefBlock[], version = 106): Uint8Array {
  const encoded = blocks.map(encodeSefBlock);
  const blocksLen = encoded.reduce((a, b) => a + b.byteLength, 0);
  const dirLen = 12 + 12 * blocks.length;
  const w = new ByteWriter(blocksLen + dirLen + 8);
  for (const e of encoded) w.bytes(e);
  const dirStart = w.length;
  w.str('SEFH').u32(version, true).u32(blocks.length, true);
  let pos = 0;
  encoded.forEach((e, i) => {
    w.u16(0, true).u16(blocks[i].type, true).u32(dirStart - pos, true).u32(e.byteLength, true);
    pos += e.byteLength;
  });
  w.u32(dirLen, true).str('SEFT');
  if (w.length - dirStart !== dirLen + 8) throw new FormatError('SEF: internal size mismatch');
  return w.toUint8Array();
}

export function sefMotionPhotoBlock(video: Uint8Array): SefBlock {
  return { type: SEF_TYPE.MotionPhotoData, name: 'MotionPhoto_Data', data: video };
}

export function sefImageUtcBlock(epochMs: number): SefBlock {
  return { type: SEF_TYPE.ImageUtcData, name: 'Image_UTC_Data', data: ascii(String(Math.round(epochMs))) };
}
