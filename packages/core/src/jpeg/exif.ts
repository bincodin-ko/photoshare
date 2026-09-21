import { ByteWriter, FormatError, ascii, decodeLatin1, startsWith, view } from '../bytes.js';

/**
 * A compact TIFF/Exif model that round-trips IFD0 / ExifIFD / GPS / Interop /
 * IFD1(thumbnail) and lets us add the one thing iOS needs to pair a still with
 * its video: Apple MakerNote tag 0x0011 (ContentIdentifier).
 *
 * Unknown tags are preserved byte-for-byte (type + count + raw value), so a
 * Samsung or Google JPEG keeps its full Exif after the rewrite.
 */

export const TIFF_TYPE_SIZE: Record<number, number> = {
  1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4,
};

export const TAG = {
  ImageWidth: 0x0100,
  ImageLength: 0x0101,
  Make: 0x010f,
  Model: 0x0110,
  Orientation: 0x0112,
  StripOffsets: 0x0111,
  StripByteCounts: 0x0117,
  Software: 0x0131,
  DateTime: 0x0132,
  JPEGInterchangeFormat: 0x0201,
  JPEGInterchangeFormatLength: 0x0202,
  ExifIFD: 0x8769,
  GPSIFD: 0x8825,
  InteropIFD: 0xa005,
  ExifVersion: 0x9000,
  DateTimeOriginal: 0x9003,
  CreateDate: 0x9004,
  OffsetTimeOriginal: 0x9011,
  SubSecTimeOriginal: 0x9291,
  MakerNote: 0x927c,
  PixelXDimension: 0xa002,
  PixelYDimension: 0xa003,
} as const;

export const APPLE_TAG = {
  MakerNoteVersion: 0x0001,
  ContentIdentifier: 0x0011,
  LivePhotoVideoIndex: 0x0017,
} as const;

export interface IfdEntry {
  tag: number;
  type: number;
  count: number;
  /** Raw value bytes in the model's byte order (length = count * typeSize). */
  value: Uint8Array;
}

export interface Ifd {
  entries: IfdEntry[];
  exif?: Ifd;
  gps?: Ifd;
  interop?: Ifd;
}

export interface ExifModel {
  le: boolean;
  ifd0: Ifd;
  /** IFD1 entries (thumbnail metadata) minus the JPEG pointer tags. */
  ifd1?: Ifd;
  /** Embedded JPEG thumbnail, if IFD1 had one. */
  thumbnail?: Uint8Array;
}

const SUB_IFD_TAGS = new Set<number>([TAG.ExifIFD, TAG.GPSIFD, TAG.InteropIFD]);
const APPLE_MAKERNOTE_HEADER = 'Apple iOS\0';

function readIfd(b: Uint8Array, off: number, le: boolean, depth: number, base = 0): { ifd: Ifd; next: number } {
  if (depth > 4) throw new FormatError('Exif: IFD nesting too deep');
  const dv = view(b);
  if (off + 2 > b.byteLength) throw new FormatError('Exif: IFD out of range');
  const n = dv.getUint16(off, le);
  const ifd: Ifd = { entries: [] };
  let p = off + 2;
  for (let i = 0; i < n; i++, p += 12) {
    if (p + 12 > b.byteLength) break;
    const tag = dv.getUint16(p, le);
    const type = dv.getUint16(p + 2, le);
    const count = dv.getUint32(p + 4, le);
    const size = TIFF_TYPE_SIZE[type];
    if (!size) continue; // unknown type: drop rather than corrupt
    const byteLen = size * count;
    let value: Uint8Array;
    if (byteLen <= 4) {
      value = b.slice(p + 8, p + 8 + byteLen);
    } else {
      const vo = dv.getUint32(p + 8, le) + base;
      if (vo + byteLen > b.byteLength) continue; // truncated value; skip
      value = b.slice(vo, vo + byteLen);
    }
    if (SUB_IFD_TAGS.has(tag) && (type === 4 || type === 13) && count === 1) {
      const so = dv.getUint32(p + 8, le) + base;
      try {
        const sub = readIfd(b, so, le, depth + 1, base).ifd;
        if (tag === TAG.ExifIFD) ifd.exif = sub;
        else if (tag === TAG.GPSIFD) ifd.gps = sub;
        else ifd.interop = sub;
      } catch {
        /* unreadable sub-IFD: drop pointer */
      }
      continue;
    }
    ifd.entries.push({ tag, type, count, value });
  }
  const next = p + 4 <= b.byteLength ? dv.getUint32(p, le) : 0;
  return { ifd, next };
}

/** Parse a TIFF blob (the bytes after the 6-byte "Exif\0\0" APP1 header). */
export function parseTiff(tiff: Uint8Array): ExifModel {
  if (tiff.byteLength < 8) throw new FormatError('Exif: too short');
  const bo = String.fromCharCode(tiff[0], tiff[1]);
  const le = bo === 'II';
  if (!le && bo !== 'MM') throw new FormatError('Exif: bad byte order');
  const dv = view(tiff);
  if (dv.getUint16(2, le) !== 42) throw new FormatError('Exif: bad TIFF magic');
  const ifd0Off = dv.getUint32(4, le);
  const { ifd: ifd0, next } = readIfd(tiff, ifd0Off, le, 0);
  const model: ExifModel = { le, ifd0 };
  if (next && next + 2 <= tiff.byteLength) {
    try {
      const { ifd: ifd1 } = readIfd(tiff, next, le, 0);
      const jif = ifd1.entries.find((e) => e.tag === TAG.JPEGInterchangeFormat);
      const jifl = ifd1.entries.find((e) => e.tag === TAG.JPEGInterchangeFormatLength);
      if (jif && jifl) {
        const to = numberOf(jif, le);
        const tl = numberOf(jifl, le);
        if (to + tl <= tiff.byteLength && tl > 0) model.thumbnail = tiff.slice(to, to + tl);
      }
      const hasStrips = ifd1.entries.some((e) => e.tag === TAG.StripOffsets);
      if (!hasStrips) {
        ifd1.entries = ifd1.entries.filter(
          (e) => e.tag !== TAG.JPEGInterchangeFormat && e.tag !== TAG.JPEGInterchangeFormatLength,
        );
        if (model.thumbnail || ifd1.entries.length) model.ifd1 = ifd1;
      }
    } catch {
      /* ignore broken IFD1 */
    }
  }
  return model;
}

export function numberOf(e: IfdEntry, le: boolean): number {
  const dv = view(e.value);
  switch (e.type) {
    case 1:
    case 7:
      return e.value[0];
    case 3:
      return dv.getUint16(0, le);
    case 4:
    case 13:
      return dv.getUint32(0, le);
    case 8:
      return dv.getInt16(0, le);
    case 9:
      return dv.getInt32(0, le);
    default:
      throw new FormatError(`Exif: tag 0x${e.tag.toString(16)} is not an integer type`);
  }
}

export function stringOf(e: IfdEntry): string {
  let end = e.value.byteLength;
  while (end > 0 && e.value[end - 1] === 0) end--;
  return decodeLatin1(e.value.subarray(0, end));
}

export function findEntry(ifd: Ifd | undefined, tag: number): IfdEntry | undefined {
  return ifd?.entries.find((e) => e.tag === tag);
}

export function setEntry(ifd: Ifd, entry: IfdEntry): void {
  const i = ifd.entries.findIndex((e) => e.tag === entry.tag);
  if (i >= 0) ifd.entries[i] = entry;
  else ifd.entries.push(entry);
}

export function asciiEntry(tag: number, s: string): IfdEntry {
  const v = new Uint8Array(s.length + 1);
  v.set(ascii(s));
  return { tag, type: 2, count: v.byteLength, value: v };
}

export function shortEntry(tag: number, n: number, le: boolean): IfdEntry {
  const v = new Uint8Array(2);
  view(v).setUint16(0, n, le);
  return { tag, type: 3, count: 1, value: v };
}

export function longEntry(tag: number, n: number, le: boolean, signed = false): IfdEntry {
  const v = new Uint8Array(4);
  if (signed) view(v).setInt32(0, n, le);
  else view(v).setUint32(0, n >>> 0, le);
  return { tag, type: signed ? 9 : 4, count: 1, value: v };
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

interface Planned {
  entries: IfdEntry[];
  exif?: Planned;
  gps?: Planned;
  interop?: Planned;
}

/**
 * Serialise one IFD (and its sub-IFDs) at `offset` relative to the TIFF start.
 * Values > 4 bytes go right after the entry table, then sub-IFDs follow.
 * `nextIfd` is the offset to write in the "next IFD" slot (0 = none).
 */
function writeIfd(w: ByteWriter, ifd: Ifd, le: boolean, nextIfdSlot?: (pos: number) => void): void {
  const pointerTags: { tag: number; sub: Ifd }[] = [];
  if (ifd.exif) pointerTags.push({ tag: TAG.ExifIFD, sub: ifd.exif });
  if (ifd.gps) pointerTags.push({ tag: TAG.GPSIFD, sub: ifd.gps });
  if (ifd.interop) pointerTags.push({ tag: TAG.InteropIFD, sub: ifd.interop });

  const entries: IfdEntry[] = ifd.entries
    .filter((e) => !SUB_IFD_TAGS.has(e.tag))
    .concat(pointerTags.map((p) => longEntry(p.tag, 0, le)))
    .sort((a, b) => a.tag - b.tag);

  const ifdStart = w.length;
  w.u16(entries.length, le);
  const entryPos: number[] = [];
  for (const e of entries) {
    entryPos.push(w.length);
    w.u16(e.tag, le).u16(e.type, le).u32(e.count, le);
    if (e.value.byteLength <= 4) {
      w.bytes(e.value).zeros(4 - e.value.byteLength);
    } else {
      w.u32(0, le); // patched below
    }
  }
  const nextPos = w.length;
  w.u32(0, le);
  if (nextIfdSlot) nextIfdSlot(nextPos);

  // Out-of-line values.
  entries.forEach((e, i) => {
    if (e.value.byteLength <= 4) return;
    if (w.length % 2) w.u8(0);
    w.patchU32(entryPos[i] + 8, w.length, le);
    w.bytes(e.value);
  });

  // Sub-IFDs.
  for (const p of pointerTags) {
    const i = entries.findIndex((e) => e.tag === p.tag);
    if (w.length % 2) w.u8(0);
    w.patchU32(entryPos[i] + 8, w.length, le);
    writeIfd(w, p.sub, le);
  }
  void ifdStart;
}

/** Serialise a model to a TIFF blob (without the "Exif\0\0" prefix). */
export function serializeTiff(model: ExifModel): Uint8Array {
  const le = model.le;
  const w = new ByteWriter(4096);
  w.str(le ? 'II' : 'MM').u16(42, le).u32(8, le);
  let nextSlot = -1;
  writeIfd(w, model.ifd0, le, (pos) => (nextSlot = pos));

  if (model.ifd1 || model.thumbnail) {
    if (w.length % 2) w.u8(0);
    w.patchU32(nextSlot, w.length, le);
    const ifd1: Ifd = { entries: [...(model.ifd1?.entries ?? [])] };
    let jifPos = -1;
    if (model.thumbnail) {
      setEntry(ifd1, longEntry(TAG.JPEGInterchangeFormat, 0, le));
      setEntry(ifd1, longEntry(TAG.JPEGInterchangeFormatLength, model.thumbnail.byteLength, le));
    }
    const start = w.length;
    writeIfd(w, ifd1, le);
    if (model.thumbnail) {
      // Locate the JPEGInterchangeFormat entry we just wrote and patch its value.
      const sorted = ifd1.entries.slice().sort((a, b) => a.tag - b.tag);
      const idx = sorted.findIndex((e) => e.tag === TAG.JPEGInterchangeFormat);
      jifPos = start + 2 + idx * 12 + 8;
      if (w.length % 2) w.u8(0);
      w.patchU32(jifPos, w.length, le);
      w.bytes(model.thumbnail);
    }
  }
  return w.toUint8Array();
}

export function emptyExif(le = false): ExifModel {
  return { le, ifd0: { entries: [], exif: { entries: [] } } };
}

// ---------------------------------------------------------------------------
// Apple MakerNote
// ---------------------------------------------------------------------------

export interface AppleMakerNote {
  le: boolean;
  version: number;
  entries: IfdEntry[];
}

export function parseAppleMakerNote(mn: Uint8Array): AppleMakerNote | undefined {
  if (!startsWith(mn, APPLE_MAKERNOTE_HEADER)) return undefined;
  if (mn.byteLength < 14) return undefined;
  const bo = String.fromCharCode(mn[12], mn[13]);
  const le = bo === 'II';
  const version = view(mn).getUint16(10, false);
  try {
    // Offsets inside an Apple MakerNote are relative to the MakerNote start.
    const { ifd } = readIfd(mn, 14, le, 3, 0);
    return { le, version, entries: ifd.entries };
  } catch {
    return undefined;
  }
}

export function serializeAppleMakerNote(mn: AppleMakerNote): Uint8Array {
  const w = new ByteWriter(256);
  w.str(APPLE_MAKERNOTE_HEADER).u16(mn.version, false).str(mn.le ? 'II' : 'MM');
  writeIfd(w, { entries: mn.entries }, mn.le);
  return w.toUint8Array();
}

export function getAppleContentIdentifier(model: ExifModel): string | undefined {
  const e = findEntry(model.ifd0.exif, TAG.MakerNote);
  if (!e) return undefined;
  const mn = parseAppleMakerNote(e.value);
  const id = mn?.entries.find((x) => x.tag === APPLE_TAG.ContentIdentifier);
  return id ? stringOf(id) : undefined;
}

/**
 * Insert (or replace) the Apple ContentIdentifier. If the file already has a
 * non-Apple MakerNote (Samsung, Google, ...) it is kept verbatim by moving it
 * to a private tag? No — Apple's tag must live in the MakerNote slot, so a
 * foreign MakerNote is replaced. Nothing user-visible lives in a Samsung
 * MakerNote (it is camera debug data), and the rest of the Exif is preserved.
 */
export function setAppleContentIdentifier(model: ExifModel, id: string): ExifModel {
  const exif = model.ifd0.exif ?? (model.ifd0.exif = { entries: [] });
  const existing = findEntry(exif, TAG.MakerNote);
  let mn = existing ? parseAppleMakerNote(existing.value) : undefined;
  if (!mn) {
    mn = { le: false, version: 15, entries: [longEntry(APPLE_TAG.MakerNoteVersion, 15, false, true)] };
  }
  const entries = mn.entries.filter((e) => e.tag !== APPLE_TAG.ContentIdentifier);
  entries.push(asciiEntry(APPLE_TAG.ContentIdentifier, id));
  mn.entries = entries;
  const blob = serializeAppleMakerNote(mn);
  setEntry(exif, { tag: TAG.MakerNote, type: 7, count: blob.byteLength, value: blob });
  if (!findEntry(exif, TAG.ExifVersion)) {
    setEntry(exif, { tag: TAG.ExifVersion, type: 7, count: 4, value: ascii('0232') });
  }
  return model;
}

// ---------------------------------------------------------------------------
// Convenience readers
// ---------------------------------------------------------------------------

export interface ExifSummary {
  make?: string;
  model?: string;
  software?: string;
  orientation?: number;
  dateTimeOriginal?: string;
  offsetTimeOriginal?: string;
  subSecTimeOriginal?: string;
  width?: number;
  height?: number;
  appleContentIdentifier?: string;
  hasAppleMakerNote: boolean;
  hasMakerNote: boolean;
}

export function summarizeExif(model: ExifModel): ExifSummary {
  const i0 = model.ifd0;
  const ex = i0.exif;
  const str = (ifd: Ifd | undefined, tag: number) => {
    const e = findEntry(ifd, tag);
    return e && e.type === 2 ? stringOf(e) : undefined;
  };
  const num = (ifd: Ifd | undefined, tag: number) => {
    const e = findEntry(ifd, tag);
    try {
      return e ? numberOf(e, model.le) : undefined;
    } catch {
      return undefined;
    }
  };
  const mn = findEntry(ex, TAG.MakerNote);
  return {
    make: str(i0, TAG.Make),
    model: str(i0, TAG.Model),
    software: str(i0, TAG.Software),
    orientation: num(i0, TAG.Orientation),
    dateTimeOriginal: str(ex, TAG.DateTimeOriginal) ?? str(ex, TAG.CreateDate) ?? str(i0, TAG.DateTime),
    offsetTimeOriginal: str(ex, TAG.OffsetTimeOriginal),
    subSecTimeOriginal: str(ex, TAG.SubSecTimeOriginal),
    width: num(ex, TAG.PixelXDimension) ?? num(i0, TAG.ImageWidth),
    height: num(ex, TAG.PixelYDimension) ?? num(i0, TAG.ImageLength),
    appleContentIdentifier: getAppleContentIdentifier(model),
    hasAppleMakerNote: !!(mn && startsWith(mn.value, APPLE_MAKERNOTE_HEADER)),
    hasMakerNote: !!mn,
  };
}

/**
 * Convert Exif "YYYY:MM:DD HH:MM:SS" (+ optional "+09:00" offset) to epoch ms.
 * Without an offset the time is interpreted as UTC-less local time; we treat it
 * as UTC so results are deterministic across machines.
 */
export function exifDateToEpochMs(dt?: string, offset?: string, subSec?: string): number | undefined {
  if (!dt) return undefined;
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(dt);
  if (!m) return undefined;
  const [, Y, M, D, h, mi, s] = m;
  let ms = Date.UTC(+Y, +M - 1, +D, +h, +mi, +s);
  if (subSec) {
    const frac = Number('0.' + subSec.replace(/\D/g, ''));
    if (!Number.isNaN(frac)) ms += Math.round(frac * 1000);
  }
  const om = offset && /^([+-])(\d{2}):(\d{2})/.exec(offset);
  if (om) {
    const sign = om[1] === '-' ? -1 : 1;
    ms -= sign * (+om[2] * 60 + +om[3]) * 60_000;
  }
  return ms;
}
