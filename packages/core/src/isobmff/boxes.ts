import { ByteWriter, FormatError, ascii, concat, fourcc, u32, u64 } from '../bytes.js';

/**
 * Minimal ISO Base Media File Format (MP4 / QuickTime MOV) box reader/writer.
 * We never decode media; we only move boxes around and patch chunk offsets.
 */

export interface Box {
  type: string;
  /** Absolute offset of the box header in the parsed buffer. */
  start: number;
  /** Total size including header. */
  size: number;
  headerSize: number;
  /** Bytes after the header (a view into the source buffer). */
  payload: Uint8Array;
  children?: Box[];
}

/** Boxes whose payload is purely a list of child boxes. */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'tref', 'mvex', 'moof', 'traf']);

/** Parse consecutive boxes in `buf[from, to)`. */
export function parseBoxes(buf: Uint8Array, from = 0, to = buf.byteLength, depth = 0): Box[] {
  const out: Box[] = [];
  let p = from;
  while (p + 8 <= to) {
    let size = u32(buf, p);
    const type = fourcc(buf, p + 4);
    let headerSize = 8;
    if (size === 1) {
      if (p + 16 > to) break;
      size = u64(buf, p + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = to - p;
    }
    if (size < headerSize || p + size > to) {
      throw new FormatError(`ISOBMFF: bad box size for '${type}' at ${p}`);
    }
    const box: Box = { type, start: p, size, headerSize, payload: buf.subarray(p + headerSize, p + size) };
    if (CONTAINERS.has(type) && depth < 8) {
      box.children = parseBoxes(buf, p + headerSize, p + size, depth + 1);
    } else if (type === 'meta' && depth < 8) {
      // QuickTime 'meta' (moov/meta with mdta keys) is a plain box in Apple's spec but
      // ffmpeg/ISO write it as a FullBox (4 bytes version/flags). Sniff for a child header.
      const skip = looksLikeBoxHeader(buf, p + headerSize) ? 0 : 4;
      box.children = parseBoxes(buf, p + headerSize + skip, p + size, depth + 1);
      (box as Box & { metaSkip?: number }).metaSkip = skip;
    }
    out.push(box);
    p += size;
  }
  return out;
}

function looksLikeBoxHeader(buf: Uint8Array, at: number): boolean {
  if (at + 8 > buf.byteLength) return false;
  const t = fourcc(buf, at + 4);
  return /^[a-zA-Z0-9 ]{4}$/.test(t) && u32(buf, at) >= 8;
}

export function metaSkip(box: Box): number {
  return (box as Box & { metaSkip?: number }).metaSkip ?? 0;
}

export function child(box: Box | undefined, type: string): Box | undefined {
  return box?.children?.find((c) => c.type === type);
}

export function childrenOf(box: Box | undefined, type: string): Box[] {
  return box?.children?.filter((c) => c.type === type) ?? [];
}

export function path(root: Box | Box[] | undefined, ...types: string[]): Box | undefined {
  let cur: Box | undefined;
  let list: Box[] | undefined = Array.isArray(root) ? root : root?.children;
  for (const t of types) {
    cur = list?.find((c) => c.type === t);
    if (!cur) return undefined;
    list = cur.children;
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  const size = 8 + body.byteLength;
  if (size > 0xffffffff) {
    const w = new ByteWriter(16);
    w.u32(1).str(type).u64(size + 8);
    return concat([w.toUint8Array(), body]);
  }
  const w = new ByteWriter(8);
  w.u32(size).str(type);
  return concat([w.toUint8Array(), body]);
}

export function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  const hdr = new ByteWriter(4).u8(version).u8((flags >> 16) & 0xff).u8((flags >> 8) & 0xff).u8(flags & 0xff);
  return box(type, hdr.toUint8Array(), ...payload);
}

/** Raw bytes of a parsed box, including its header. */
export function rawBox(buf: Uint8Array, b: Box): Uint8Array {
  return buf.subarray(b.start, b.start + b.size);
}

export function be32(n: number): Uint8Array {
  return new ByteWriter(4).u32(n).toUint8Array();
}

export function ftypBox(major: string, minor: number, compatible: string[]): Uint8Array {
  const w = new ByteWriter(8 + 4 * compatible.length);
  w.str(major.padEnd(4).slice(0, 4)).u32(minor);
  for (const c of compatible) w.str(c.padEnd(4).slice(0, 4));
  return box('ftyp', w.toUint8Array());
}

export function isIsobmff(b: Uint8Array): boolean {
  return b.byteLength >= 12 && fourcc(b, 4) === 'ftyp';
}

export function majorBrand(b: Uint8Array): string | undefined {
  return isIsobmff(b) ? fourcc(b, 8) : undefined;
}

export function compatibleBrands(b: Uint8Array): string[] {
  if (!isIsobmff(b)) return [];
  const size = u32(b, 0);
  const out: string[] = [];
  for (let p = 16; p + 4 <= Math.min(size, b.byteLength); p += 4) out.push(fourcc(b, p));
  return out;
}

export const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1', 'heim', 'heis', 'avif']);

export function isHeif(b: Uint8Array): boolean {
  const mb = majorBrand(b);
  if (!mb) return false;
  return HEIF_BRANDS.has(mb) || compatibleBrands(b).some((x) => HEIF_BRANDS.has(x));
}

export function isVideoContainer(b: Uint8Array): boolean {
  return isIsobmff(b) && !isHeif(b);
}

export { ascii as _ascii };
