import { FormatError, concat, u16 } from '../bytes.js';

/**
 * JPEG = SOI, a list of marker segments, entropy-coded scan data, EOI, and then
 * (in our world) a trailer that phone vendors abuse to hide videos in.
 */

export interface JpegSegment {
  /** Marker byte after 0xFF, e.g. 0xE1 for APP1. */
  marker: number;
  /** Absolute offset of the 0xFF marker byte. */
  offset: number;
  /** Payload without the 2-byte length prefix. */
  data: Uint8Array;
}

export interface ParsedJpeg {
  /** All marker segments before SOS, in file order. */
  segments: JpegSegment[];
  /** Offset of the SOS marker (0xFFDA). Everything from here up to and including EOI is left untouched. */
  sosOffset: number;
  /** Offset just past the EOI marker (0xFFD9) — i.e. where the trailer starts. */
  eoiEnd: number;
  /** Bytes after EOI. */
  trailer: Uint8Array;
}

export const MARKER = {
  SOI: 0xd8,
  EOI: 0xd9,
  SOS: 0xda,
  APP0: 0xe0,
  APP1: 0xe1,
  APP2: 0xe2,
  DQT: 0xdb,
  SOF0: 0xc0,
} as const;

export const EXIF_HEADER = 'Exif\0\0';
export const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';
export const XMP_EXT_HEADER = 'http://ns.adobe.com/xmp/extension/\0';

export function isJpeg(b: Uint8Array): boolean {
  return b.byteLength > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

/**
 * Find the end of the entropy-coded image data starting at SOS.
 * Scans for the EOI marker while skipping RSTn markers and stuffed 0xFF00 bytes.
 * Progressive JPEGs contain multiple SOS segments; they are handled because we
 * keep scanning until a real EOI is seen.
 */
function findEoi(b: Uint8Array, from: number): number {
  let i = from;
  while (i < b.byteLength - 1) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const m = b[i + 1];
    if (m === 0x00 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) {
      i += m === 0xff ? 1 : 2;
      continue;
    }
    if (m === MARKER.EOI) return i + 2;
    // Another marker segment inside the scan region (e.g. DHT/SOS of a progressive JPEG).
    if (i + 4 <= b.byteLength) {
      const len = u16(b, i + 2);
      i += 2 + len;
      continue;
    }
    break;
  }
  throw new FormatError('JPEG: EOI marker not found');
}

export function parseJpeg(b: Uint8Array): ParsedJpeg {
  if (!isJpeg(b)) throw new FormatError('Not a JPEG (missing SOI)');
  const segments: JpegSegment[] = [];
  let i = 2;
  while (i < b.byteLength) {
    if (b[i] !== 0xff) throw new FormatError(`JPEG: expected marker at ${i}`);
    // Padding 0xFF bytes are legal between segments.
    while (b[i] === 0xff && i < b.byteLength) i++;
    const marker = b[i];
    if (marker === MARKER.SOS) {
      const sosOffset = i - 1;
      const eoiEnd = findEoi(b, sosOffset + 2);
      return { segments, sosOffset, eoiEnd, trailer: b.subarray(eoiEnd) };
    }
    if (marker === MARKER.EOI) throw new FormatError('JPEG: EOI before SOS');
    if (marker >= 0xd0 && marker <= 0xd7) {
      i++;
      continue;
    }
    const len = u16(b, i + 1);
    if (len < 2) throw new FormatError('JPEG: bad segment length');
    const data = b.subarray(i + 3, i + 1 + len);
    segments.push({ marker, offset: i - 1, data });
    i += 1 + len;
  }
  throw new FormatError('JPEG: SOS not found');
}

export function segmentPayloadStartsWith(seg: JpegSegment, header: string): boolean {
  if (seg.data.byteLength < header.length) return false;
  for (let i = 0; i < header.length; i++) if (seg.data[i] !== header.charCodeAt(i)) return false;
  return true;
}

export function findExifSegment(p: ParsedJpeg): JpegSegment | undefined {
  return p.segments.find((s) => s.marker === MARKER.APP1 && segmentPayloadStartsWith(s, EXIF_HEADER));
}

export function findXmpSegment(p: ParsedJpeg): JpegSegment | undefined {
  return p.segments.find((s) => s.marker === MARKER.APP1 && segmentPayloadStartsWith(s, XMP_HEADER));
}

function encodeSegment(marker: number, data: Uint8Array): Uint8Array {
  if (data.byteLength + 2 > 0xffff) throw new FormatError('JPEG: segment too large (>64KB)');
  const out = new Uint8Array(4 + data.byteLength);
  out[0] = 0xff;
  out[1] = marker;
  out[2] = ((data.byteLength + 2) >> 8) & 0xff;
  out[3] = (data.byteLength + 2) & 0xff;
  out.set(data, 4);
  return out;
}

/**
 * Rebuild a JPEG from (possibly edited) marker segments while copying the scan
 * data verbatim. `trailer` defaults to nothing (trailers are re-attached by the
 * motion photo builder on purpose so we never carry a stale one).
 */
export function rebuildJpeg(
  original: Uint8Array,
  parsed: ParsedJpeg,
  segments: JpegSegment[],
  trailer: Uint8Array = new Uint8Array(0),
): Uint8Array {
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8])];
  for (const s of segments) parts.push(encodeSegment(s.marker, s.data));
  parts.push(original.subarray(parsed.sosOffset, parsed.eoiEnd));
  if (trailer.byteLength) parts.push(trailer);
  return concat(parts);
}

/** JPEG without any trailer bytes (what a plain viewer sees). */
export function stripTrailer(b: Uint8Array): Uint8Array {
  const p = parseJpeg(b);
  return b.subarray(0, p.eoiEnd);
}

/**
 * Standard ordering rule when we insert/replace metadata segments:
 * APP0 (JFIF) first, then Exif APP1, then XMP APP1, then everything else.
 */
export function upsertApp1(segments: JpegSegment[], header: string, payload: Uint8Array): JpegSegment[] {
  const out = segments.filter((s) => !(s.marker === MARKER.APP1 && segmentPayloadStartsWith(s, header)));
  const seg: JpegSegment = { marker: MARKER.APP1, offset: -1, data: payload };
  let insertAt = 0;
  // Skip APP0 always; skip Exif APP1 when inserting XMP.
  while (insertAt < out.length) {
    const s = out[insertAt];
    const isApp0 = s.marker === MARKER.APP0;
    const isExif = s.marker === MARKER.APP1 && segmentPayloadStartsWith(s, EXIF_HEADER);
    if (isApp0 || (header === XMP_HEADER && isExif)) insertAt++;
    else break;
  }
  out.splice(insertAt, 0, seg);
  return out;
}
