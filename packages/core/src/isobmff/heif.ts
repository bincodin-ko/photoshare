import { FormatError, concat, fourcc, startsWith, u16, u32, u64, view } from '../bytes.js';
import { Box, box, child, isHeif, parseBoxes, path } from './boxes.js';
import { ExifModel, parseTiff, serializeTiff } from '../jpeg/exif.js';
import { SefTrailer, parseSefTrailer } from '../samsung/sef.js';

/**
 * HEIF/HEIC support limited to what Live/Motion photos need:
 *  - find where the HEIF ends and vendor trailers begin,
 *  - read the Exif item,
 *  - replace the Exif item without touching anything else (append + iloc patch),
 *  - find an embedded motion video ('mpvd' box, Samsung 'sefd' box or SEF trailer).
 */

export interface HeifLayout {
  /** Top-level boxes that form the HEIF proper. */
  boxes: Box[];
  /** Offset where the well-formed boxes end (trailer start). */
  end: number;
}

const PRINTABLE = /^[A-Za-z0-9 ]{4}$/;

/** Parse top-level boxes leniently: stop at the first thing that is not a box. */
export function heifLayout(file: Uint8Array): HeifLayout {
  const boxes: Box[] = [];
  let p = 0;
  while (p + 8 <= file.byteLength) {
    let size = u32(file, p);
    const type = fourcc(file, p + 4);
    let headerSize = 8;
    if (!PRINTABLE.test(type)) break;
    if (size === 1) {
      if (p + 16 > file.byteLength) break;
      size = u64(file, p + 8);
      headerSize = 16;
    } else if (size === 0) {
      size = file.byteLength - p;
    }
    if (size < headerSize || p + size > file.byteLength) break;
    const b: Box = { type, start: p, size, headerSize, payload: file.subarray(p + headerSize, p + size) };
    if (type === 'meta') {
      // HEIF 'meta' is a FullBox.
      b.children = parseBoxes(file, p + headerSize + 4, p + size, 1);
    }
    boxes.push(b);
    p += size;
  }
  return { boxes, end: p };
}

interface ItemLoc {
  itemId: number;
  constructionMethod: number;
  baseOffset: number;
  extents: { offset: number; length: number }[];
  /** Absolute file positions of the first extent's offset/length fields plus their byte widths, for patching. */
  patch?: { offsetPos: number; offsetSize: number; lengthPos: number; lengthSize: number };
}

function readIloc(iloc: Box, fileOffsetOfPayload: number): ItemLoc[] {
  const p = iloc.payload;
  const v = p[0];
  const offsetSize = p[4] >> 4;
  const lengthSize = p[4] & 0xf;
  const baseOffsetSize = p[5] >> 4;
  const indexSize = v === 1 || v === 2 ? p[5] & 0xf : 0;
  let o = 6;
  let count: number;
  if (v < 2) {
    count = u16(p, o);
    o += 2;
  } else {
    count = u32(p, o);
    o += 4;
  }
  const readN = (size: number): number => {
    let val = 0;
    if (size === 4) val = u32(p, o);
    else if (size === 8) val = u64(p, o);
    else if (size === 0) val = 0;
    else throw new FormatError('HEIF: unsupported iloc field size');
    o += size;
    return val;
  };
  const items: ItemLoc[] = [];
  for (let i = 0; i < count; i++) {
    let itemId: number;
    if (v < 2) {
      itemId = u16(p, o);
      o += 2;
    } else {
      itemId = u32(p, o);
      o += 4;
    }
    let cm = 0;
    if (v === 1 || v === 2) {
      cm = u16(p, o) & 0xf;
      o += 2;
    }
    o += 2; // data_reference_index
    const baseOffset = readN(baseOffsetSize);
    const extentCount = u16(p, o);
    o += 2;
    const extents: { offset: number; length: number }[] = [];
    let patch: ItemLoc['patch'];
    for (let e = 0; e < extentCount; e++) {
      if (indexSize) readN(indexSize);
      const offsetPos = fileOffsetOfPayload + o;
      const offset = readN(offsetSize);
      const lengthPos = fileOffsetOfPayload + o;
      const length = readN(lengthSize);
      extents.push({ offset, length });
      if (e === 0) patch = { offsetPos, offsetSize, lengthPos, lengthSize };
    }
    items.push({ itemId, constructionMethod: cm, baseOffset, extents, patch });
  }
  return items;
}

function readItemTypes(file: Uint8Array, iinf: Box): Map<number, string> {
  const out = new Map<number, string>();
  const p = iinf.payload;
  const v = p[0];
  const start = iinf.start + iinf.headerSize + (v === 0 ? 6 : 8);
  const infes = parseBoxes(file, start, iinf.start + iinf.size, 2);
  for (const infe of infes) {
    if (infe.type !== 'infe') continue;
    const q = infe.payload;
    const iv = q[0];
    if (iv === 2) out.set(u16(q, 4), fourcc(q, 8));
    else if (iv === 3) out.set(u32(q, 4), fourcc(q, 10));
  }
  return out;
}

export interface HeifExif {
  model: ExifModel;
  /** The raw Exif item payload (ExifDataBlock). */
  raw: Uint8Array;
  loc: ItemLoc;
  tiffOffset: number;
}

export function readHeifExif(file: Uint8Array): HeifExif | undefined {
  if (!isHeif(file)) return undefined;
  const { boxes } = heifLayout(file);
  const meta = boxes.find((b) => b.type === 'meta');
  const iinf = child(meta, 'iinf');
  const iloc = child(meta, 'iloc');
  const idat = child(meta, 'idat');
  if (!meta || !iinf || !iloc) return undefined;
  const types = readItemTypes(file, iinf);
  const exifId = [...types.entries()].find(([, t]) => t === 'Exif')?.[0];
  if (exifId === undefined) return undefined;
  const loc = readIloc(iloc, iloc.start + iloc.headerSize).find((l) => l.itemId === exifId);
  if (!loc || loc.extents.length === 0) return undefined;
  const parts = loc.extents.map((e) => {
    if (loc.constructionMethod === 1) {
      if (!idat) throw new FormatError('HEIF: idat missing');
      return idat.payload.subarray(e.offset, e.offset + e.length);
    }
    const abs = loc.baseOffset + e.offset;
    return file.subarray(abs, abs + e.length);
  });
  const raw = concat(parts);
  if (raw.byteLength < 4) return undefined;
  const tiffOffset = 4 + u32(raw, 0);
  const tiff = startsWith(raw, 'Exif\0\0', tiffOffset) ? raw.subarray(tiffOffset + 6) : raw.subarray(tiffOffset);
  return { model: parseTiff(tiff), raw, loc, tiffOffset };
}

/**
 * Write a new Exif model into a HEIF by appending the payload in a fresh mdat
 * and re-pointing the Exif item's (single) extent at it. All other bytes are
 * untouched, so image data and other item offsets stay valid.
 */
export function writeHeifExif(file: Uint8Array, model: ExifModel): Uint8Array {
  const cur = readHeifExif(file);
  if (!cur) throw new FormatError('HEIF: no Exif item to replace');
  const { loc } = cur;
  if (loc.constructionMethod !== 0 || loc.extents.length !== 1 || !loc.patch) {
    throw new FormatError('HEIF: Exif item layout not supported (multiple extents or idat)');
  }
  if (loc.patch.offsetSize === 0 || loc.patch.lengthSize === 0) {
    throw new FormatError('HEIF: iloc has no writable offset/length for the Exif item');
  }
  const { end } = heifLayout(file);
  const head = file.subarray(0, end).slice();
  const tiff = serializeTiff(model);
  const payload = concat([new Uint8Array([0, 0, 0, 6]), new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0]), tiff]);
  const mdat = box('mdat', payload);
  const newOffset = head.byteLength + 8 - loc.baseOffset;
  const dv = view(head);
  if (loc.patch.offsetSize === 4) dv.setUint32(loc.patch.offsetPos, newOffset);
  else dv.setBigUint64(loc.patch.offsetPos, BigInt(newOffset));
  if (loc.patch.lengthSize === 4) dv.setUint32(loc.patch.lengthPos, payload.byteLength);
  else dv.setBigUint64(loc.patch.lengthPos, BigInt(payload.byteLength));
  return concat([head, mdat]);
}

export interface HeifMotionVideo {
  video: Uint8Array;
  source: 'mpvd' | 'sefd' | 'sef-trailer' | 'scan';
  sef?: SefTrailer;
}

/** Find a motion video embedded in a HEIF (Samsung/Google styles). */
export function findHeifMotionVideo(file: Uint8Array): HeifMotionVideo | undefined {
  const { boxes, end } = heifLayout(file);
  const mpvd = boxes.find((b) => b.type === 'mpvd');
  if (mpvd) return { video: mpvd.payload, source: 'mpvd' };
  const sefd = boxes.find((b) => b.type === 'sefd');
  if (sefd) {
    const sef = parseSefTrailer(sefd.payload);
    const blk = sef?.blocks.find((b) => b.name === 'MotionPhoto_Data' || b.type === 0x0a30);
    if (blk && blk.data.byteLength > 16) return { video: blk.data, source: 'sefd', sef };
  }
  const trailer = file.subarray(end);
  const sef = parseSefTrailer(file);
  const blk = sef?.blocks.find((b) => b.name === 'MotionPhoto_Data' || b.type === 0x0a30);
  if (blk && blk.data.byteLength > 16) return { video: blk.data, source: 'sef-trailer', sef };
  const idx = indexOfFtyp(trailer);
  if (idx >= 0) return { video: trailer.subarray(idx, mp4Extent(trailer, idx)), source: 'scan' };
  return undefined;
}

/** Plain HEIF without trailers or motion boxes. */
export function heifStillOnly(file: Uint8Array): Uint8Array {
  const { boxes } = heifLayout(file);
  const keep = boxes.filter((b) => b.type !== 'mpvd' && b.type !== 'sefd');
  return concat(keep.map((b) => file.subarray(b.start, b.start + b.size)));
}

/** Index of the box header of the first 'ftyp' found in `b` (i.e. 4 bytes before the fourcc). */
export function indexOfFtyp(b: Uint8Array, from = 0): number {
  for (let i = Math.max(4, from); i + 4 <= b.byteLength; i++) {
    if (b[i] === 0x66 && b[i + 1] === 0x74 && b[i + 2] === 0x79 && b[i + 3] === 0x70) return i - 4;
  }
  return -1;
}

/** Walk boxes from `start` and return the offset where the MP4 stops being well-formed. */
export function mp4Extent(b: Uint8Array, start: number): number {
  let p = start;
  while (p + 8 <= b.byteLength) {
    let size = u32(b, p);
    const type = fourcc(b, p + 4);
    if (!PRINTABLE.test(type)) break;
    if (size === 1) {
      if (p + 16 > b.byteLength) break;
      size = u64(b, p + 8);
    } else if (size === 0) {
      size = b.byteLength - p;
    }
    if (size < 8 || p + size > b.byteLength) break;
    p += size;
  }
  return p;
}

export { path as _path };
